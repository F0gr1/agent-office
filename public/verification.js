export function verificationGroups(result) {
  const groups = { verified: [], unverified: [], failed: [], unclassified: [], issues: [] };
  for (const item of result?.verification || []) {
    if (groups[item?.status]) groups[item.status].push(item);
  }
  groups.unclassified = Array.isArray(result?.checks) ? result.checks : [];
  groups.issues = Array.isArray(result?.issues) ? result.issues : [];
  return groups;
}
