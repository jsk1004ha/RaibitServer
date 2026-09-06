export function mutationPayload(formData, repositoryDefaultBranches = {}) {
  const output = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== 'string') return null;
    if (key === '_returnTo') continue;
    if (key === 'expectedCatalogGeneration') {
      if (!/^\d+$/.test(value)) return null;
      output[key] = Number(value);
      continue;
    }
    if ((key === 'serviceSlug' || key === 'serviceName') && value === '') continue;
    output[key] = value;
  }
  const repositoryId = output.repositoryId;
  const expectedDefaultBranch = typeof repositoryId === 'string' ? repositoryDefaultBranches[repositoryId] : undefined;
  if (typeof expectedDefaultBranch === 'string' && expectedDefaultBranch.length > 0) output.expectedDefaultBranch = expectedDefaultBranch;
  else delete output.expectedDefaultBranch;
  return output;
}
