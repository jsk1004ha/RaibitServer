import { cookies } from 'next/headers';
import { resolveOrganizationRouteValue, WORKSPACE_PREFERENCE_COOKIE } from './console-navigation';

type Selection = Parameters<typeof resolveOrganizationRouteValue>[0];

export async function selectedWorkspace(selection: Selection = {}): Promise<string> {
  const preference = (await cookies()).get(WORKSPACE_PREFERENCE_COOKIE)?.value;
  return resolveOrganizationRouteValue({ ...selection, preferred: preference });
}
