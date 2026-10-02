import { NONE_MESSAGE } from "./schemas.mjs";

export function createNoneProvider() {
  return {
    name: "none",
    computerUse: false,
    message: NONE_MESSAGE,
    async next() {
      return { requestBody: null, actions: [], text: NONE_MESSAGE, costUsd: 0 };
    },
  };
}
