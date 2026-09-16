export const governanceFaults=Object.freeze(["mutation","omission","duplication","reordering","stale","fork","cycle","privacy"]);export const isGovernanceFault=x=>governanceFaults.includes(x);
