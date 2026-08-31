import { apiAction } from '@/lib/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { exactPattern } from './model';
import { ProjectStatusBadge } from './shared';
import type { ProjectHubData } from './types';

export function SettingsView({ data, orgSlug }: Readonly<{ data: ProjectHubData; orgSlug: string }>) {
  return (
    <Card className="border-destructive/25">
      <CardHeader><CardTitle><h2>프로젝트 삭제</h2></CardTitle><CardDescription>서비스와 리소스도 함께 삭제됩니다. 이 작업은 되돌릴 수 없습니다.</CardDescription></CardHeader>
      {data.deletionPending ? <CardContent><Alert><ProjectStatusBadge status={data.project.status} /><AlertTitle>삭제 요청됨</AlertTitle><AlertDescription>삭제 작업이 끝날 때까지 프로젝트 설정을 변경할 수 없습니다.</AlertDescription></Alert></CardContent> : <form action={apiAction(`/projects/${data.projectId}`, data.context)} method="post"><input name="_method" type="hidden" value="DELETE" /><input name="_returnTo" type="hidden" value={`/org/${orgSlug}/projects`} /><CardContent><FieldGroup><Field><FieldLabel htmlFor="project-delete-confirmation">확인을 위해 <strong>{data.projectName}</strong> 입력</FieldLabel><Input autoComplete="off" id="project-delete-confirmation" name="_confirmProject" pattern={exactPattern(data.projectName)} required /><FieldDescription>프로젝트 이름과 정확히 일치해야 삭제 요청을 보낼 수 있습니다.</FieldDescription></Field></FieldGroup></CardContent><CardFooter className="mt-raibit-xl justify-end"><button className={buttonVariants({ variant: 'destructive' })} type="submit">프로젝트 삭제</button></CardFooter></form>}
    </Card>
  );
}
