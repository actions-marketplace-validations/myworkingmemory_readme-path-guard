export function rotate(items, step) {
  if (!items.length) return [];
  const offset = ((step % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

// Mixed-radix rotation prevents a heavy first installation/repository/PR from
// owning every cycle. Cursor contains no private identifiers or repository data.
export function rotationSteps(epoch, installationCount, repoCount = 1) {
  const installations = Math.max(1, installationCount);
  return { installation: epoch, repository: Math.floor(epoch / installations),
    pull: Math.floor(epoch / (installations * Math.max(1, repoCount))) };
}
