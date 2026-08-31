import { apiAction } from '@/lib/api';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { HubEmpty } from './shared';
import type { ProjectHubData } from './types';

export function EnvironmentView({ data }: Readonly<{ data: ProjectHubData }>) {
  const service = data.environmentService;
  if (!service) return <HubEmpty title="환경 변수를 연결할 서비스가 없습니다." description="서비스를 만든 뒤 비밀값과 일반 설정을 추가할 수 있습니다." action={<a className={buttonVariants()} href={`${data.base}?view=new-service`}>서비스 만들기</a>} />;
  const returnTo = `${data.base}?view=environment&serviceId=${encodeURIComponent(service.id)}`;
  return (
    <div className="flex flex-col gap-raibit-lg">
      <nav aria-label="환경 변수를 관리할 서비스" className="flex min-w-0 gap-raibit-sm overflow-x-auto border-b border-border pb-raibit-sm">
        {data.services.map((item) => {
          const current = item.id === service.id;
          return <a aria-current={current ? 'page' : undefined} className={cn('min-h-9 shrink-0 rounded-sm border px-raibit-md py-raibit-sm text-button-md', current ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-background text-muted-foreground hover:bg-muted')} href={`${data.base}?view=environment&serviceId=${encodeURIComponent(item.id)}`} key={item.id}>{item.name || item.slug || item.id}</a>;
        })}
      </nav>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(22rem,100%),1fr))] items-start gap-raibit-lg">
        <Card>
          <CardHeader><CardTitle><h2>환경 변수</h2></CardTitle><CardDescription>{service.name || '서비스'}에 저장된 값 · {data.environmentEntries.length}개</CardDescription></CardHeader>
          <CardContent>{data.environmentEntries.length > 0 ? <div className="flex flex-col divide-y divide-border">{data.environmentEntries.map((entry) => <div className="grid min-w-0 gap-raibit-sm py-raibit-md sm:grid-cols-[minmax(0,1fr)_minmax(8rem,0.75fr)_auto] sm:items-center" key={entry.key}><span className="min-w-0"><strong className="block break-words font-mono [overflow-wrap:anywhere]">{entry.key}</strong><small className="text-muted-foreground">{entry.source || 'api'} · {entry.isSecret ? '비밀값' : '일반값'}</small></span><code className="min-w-0 break-words rounded-xs bg-muted px-raibit-sm py-raibit-xs text-code [overflow-wrap:anywhere]">{entry.isSecret ? entry.valueMasked || '••••••••' : String(entry.value ?? entry.valueMasked ?? '')}</code><a className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={`${returnTo}&envKey=${encodeURIComponent(entry.key)}`}>수정</a></div>)}</div> : <HubEmpty title="등록된 환경 변수가 없습니다." description="아래 폼이나 .env 가져오기로 첫 값을 추가하세요." />}</CardContent>
        </Card>
        <div className="flex flex-col gap-raibit-lg">
          <Card>
            <CardHeader><CardTitle><h2>{data.editedEnvironment ? '환경 변수 수정' : '환경 변수 추가'}</h2></CardTitle><CardDescription>같은 키를 저장하면 새 값으로 안전하게 교체됩니다.</CardDescription></CardHeader>
            <form action={apiAction(`/projects/${data.projectId}/services/${service.id}/env`, data.context)} method="post">
              <input name="_returnTo" type="hidden" value={returnTo} />
              <CardContent><FieldGroup><Field><FieldLabel htmlFor="environment-key">키</FieldLabel><Input autoComplete="off" defaultValue={data.editedEnvironment?.key || ''} id="environment-key" name="key" pattern="[A-Za-z_][A-Za-z0-9_]*" placeholder="API_TOKEN" readOnly={Boolean(data.editedEnvironment)} required /></Field><Field><FieldLabel htmlFor="environment-value">값</FieldLabel><Input autoComplete="new-password" defaultValue={data.editedEnvironment?.isSecret ? '' : data.editedEnvironment?.value || ''} id="environment-value" name="value" placeholder={data.editedEnvironment?.isSecret ? '새 비밀값 입력' : '값 입력'} required type={data.editedEnvironment?.isSecret ? 'password' : 'text'} /></Field><FieldSet><FieldLegend variant="label">보안 분류</FieldLegend><Field orientation="horizontal"><input className="size-4 accent-primary" defaultChecked={Boolean(data.editedEnvironment?.isSecret)} id="environment-secret" name="isSecret" type="checkbox" /><FieldLabel htmlFor="environment-secret">비밀값으로 암호화하여 저장하고 목록에는 마스킹하기</FieldLabel></Field></FieldSet></FieldGroup></CardContent>
              <CardFooter className="mt-raibit-xl justify-end gap-raibit-sm">{data.editedEnvironment ? <a className={buttonVariants({ variant: 'ghost' })} href={returnTo}>취소</a> : null}<button className={buttonVariants()} type="submit">{data.editedEnvironment ? '새 값 저장' : '환경 변수 추가'}</button></CardFooter>
            </form>
          </Card>
          <Card>
            <CardHeader><CardTitle><h2>.env 텍스트 가져오기</h2></CardTitle><CardDescription>한 줄에 KEY=value 형식으로 붙여 넣으세요. 비밀로 보이는 키는 자동 분류됩니다.</CardDescription></CardHeader>
            <form action={apiAction(`/projects/${data.projectId}/services/${service.id}/env-file`, data.context)} method="post"><input name="_returnTo" type="hidden" value={returnTo} /><CardContent><Field><FieldLabel htmlFor="environment-content">.env 내용</FieldLabel><Textarea autoComplete="off" id="environment-content" name="content" placeholder={'NODE_ENV=production\nAPI_TOKEN=your-secret'} required rows={8} /><FieldDescription>내용은 서버에 직접 전송되며 URL에 포함되지 않습니다.</FieldDescription></Field></CardContent><CardFooter className="mt-raibit-xl justify-end"><button className={buttonVariants({ variant: 'outline' })} type="submit">.env 가져오기</button></CardFooter></form>
          </Card>
        </div>
      </div>
    </div>
  );
}
