import { getCurrentUnixTimestamp } from "../src/utils/date";
import { fetchAllTokens } from "./layer2pg";
import { McapData, TokenTvlData, DollarValues } from "./types";
import { Chain } from "@defillama/sdk/build/general";
import BigNumber from "bignumber.js";
import { Address } from "@defillama/sdk/build/types";
import { zero } from "./constants";
import { getMcaps, getPrices, fetchBridgeTokenList, fetchSupplies } from "./utils";
import fetchThirdPartyTokenList from "./adapters/thirdParty";
import { fetchAdaTokens } from "./adapters/ada";

export async function fetchMinted(params: {
  chains: Chain[];
  timestamp?: number;
  searchWidth?: number;
}): Promise<{ tvlData: TokenTvlData; mcapData: McapData }> {
  const timestamp: number = params.timestamp ?? getCurrentUnixTimestamp();
  const tvlData: TokenTvlData = {};
  const mcapData: McapData = { total: {} };

  await Promise.all(
    params.chains.map(async (chain: Chain) => {
      const canonicalTokens: Address[] = await fetchBridgeTokenList(chain);
      const thirdPartyTokens: Address[] = (await fetchThirdPartyTokenList())[chain] ?? [];
      const incomingTokens = [...new Set([...canonicalTokens, ...thirdPartyTokens])];

      let storedTokens = await fetchAllTokens(chain);

      // filter any tokens that arent natively minted
      incomingTokens.map((t: Address) => {
        const i = storedTokens.indexOf(t);
        if (i == -1) return;
        storedTokens.splice(i, 1);
      });

      if (chain == "cardano") storedTokens = await fetchAdaTokens();
      // do these in order to lighten rpc, rest load
      const supplies = await fetchSupplies(chain, storedTokens, params.timestamp);
      const prices = await getPrices(Object.keys(supplies), timestamp);
      const mcaps = await getMcaps(Object.keys(prices), timestamp);

      function findDollarValues() {
        Object.keys(mcaps).map((t: string) => {
          const priceInfo = prices[t];
          const mcapInfo = mcaps[t];
          const supply = supplies[t];
          if (!priceInfo || !supply || !mcapInfo) return;
          if (!(priceInfo.symbol in dollarValues)) dollarValues[priceInfo.symbol] = zero;
          const decimalShift: BigNumber = BigNumber(10).pow(BigNumber(priceInfo.decimals));
          const usdValue: BigNumber = BigNumber(priceInfo.price).times(BigNumber(supply)).div(decimalShift);
          if (usdValue.isGreaterThan(BigNumber(1e12))) {
            console.log(`token ${t} on ${chain} has over a trillion usdValue LOL`);
            return;
          }
          mcapData[chain][priceInfo.symbol] = { native: usdValue, total: BigNumber(mcapInfo.mcap) };
          if (priceInfo.symbol in mcapData.total)
            mcapData.total[priceInfo.symbol].native = mcapData.total[priceInfo.symbol].native.plus(usdValue);
          else mcapData.total[priceInfo.symbol] = { native: usdValue, total: BigNumber(mcapInfo.mcap) };
          dollarValues[priceInfo.symbol] = BigNumber(usdValue).plus(dollarValues[priceInfo.symbol]);
        });
      }

      const dollarValues: DollarValues = {};
      mcapData[chain] = {};
      findDollarValues();

      tvlData[chain] = dollarValues;
    })
  );
  return { tvlData, mcapData };
}
