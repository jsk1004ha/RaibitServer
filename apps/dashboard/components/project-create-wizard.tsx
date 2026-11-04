'use client';

import Link from 'next/link';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { CreationSourceFields } from './creation-source-fields';

export function ProjectCreateWizard({ action, orgSlug }: Readonly<{ action: string; orgSlug: string }>) {
  return (
    <form method="post" action={action} data-project-create-form onInvalidCapture={(event) => {
      if (event.target instanceof HTMLElement) event.target.closest('details')?.setAttribute('open', '');
    }}>
      <input type="hidden" name="_returnTo" value={`/org/${orgSlug}/projects`} />
      <Card>
        <CardHeader><CardTitle><h2>이름과 코드 연결</h2></CardTitle><CardDescription>웹 서비스를 기본으로 만듭니다. 나머지 설정은 필요할 때 변경하세요.</CardDescription></CardHeader>
        <CardContent>
          <FieldGroup>
            <Field><FieldLabel htmlFor="project-name">프로젝트 이름</FieldLabel><Input id="project-name" name="name" required placeholder="동아리 웹사이트" autoComplete="off" /></Field>
            <CreationSourceFields imageField="image" />
            <details>
              <summary className="cursor-pointer rounded-sm py-raibit-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25">주소 이름 변경 (선택)</summary>
              <Field className="mt-raibit-md"><FieldLabel htmlFor="project-slug">주소 이름</FieldLabel><Input id="project-slug" name="slug" placeholder="club-website" autoCapitalize="none" spellCheck={false} pattern="[a-z0-9]+(-[a-z0-9]+)*" maxLength={63} /><FieldDescription>비워 두면 자동으로 정합니다. 직접 정할 때는 영문 소문자, 숫자, 하이픈을 사용하세요. 전체 주소는 프로젝트를 만든 뒤 확인할 수 있습니다.</FieldDescription></Field>
            </details>
            <details>
              <summary className="cursor-pointer rounded-sm py-raibit-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25">서비스 설정 (선택)</summary>
              <FieldGroup className="mt-raibit-md sm:grid sm:grid-cols-2">
                <Field><FieldLabel htmlFor="service-name">서비스 이름</FieldLabel><Input id="service-name" name="serviceName" defaultValue="web" required /></Field>
                <Field><FieldLabel htmlFor="service-type">서비스 유형</FieldLabel><Select id="service-type" name="type" defaultValue="web"><option value="web">웹</option><option value="private">비공개 서비스</option><option value="worker">워커</option><option value="cron">예약 작업</option><option value="job">일회성 작업</option></Select></Field>
              </FieldGroup>
            </details>
            <details>
              <summary className="cursor-pointer rounded-sm py-raibit-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25">데이터베이스·캐시 추가 (선택)</summary>
              <FieldGroup className="mt-raibit-md sm:grid sm:grid-cols-2">
                <Field><FieldLabel htmlFor="database">데이터베이스</FieldLabel><Select id="database" name="database" defaultValue="none"><option value="none">추가 안 함</option><option value="postgresql">PostgreSQL</option><option value="mysql">MySQL</option><option value="mongodb">MongoDB</option></Select></Field>
                <Field><FieldLabel htmlFor="cache">캐시</FieldLabel><Select id="cache" name="cache" defaultValue="none"><option value="none">추가 안 함</option><option value="redis">Redis</option><option value="valkey">Valkey</option></Select></Field>
              </FieldGroup>
            </details>
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end gap-raibit-sm"><Link className={buttonVariants({ variant: 'outline' })} href={`/org/${orgSlug}/projects`}>취소</Link><button type="submit" className={buttonVariants()} data-wizard-submit>프로젝트 만들기</button></CardFooter>
      </Card>
    </form>
  );
}
