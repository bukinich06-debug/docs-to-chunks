
export const mergeChunksSemantically = <T>(runs: T[][]): T[] => {
  if (runs.length === 0) return [];

  return runs.reduce((longestRun, currentRun) =>
    currentRun.length > longestRun.length ? currentRun : longestRun
  );
};
