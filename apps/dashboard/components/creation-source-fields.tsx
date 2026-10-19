'use client';

import { useState } from 'react';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

export function CreationSourceFields({ imageField, initialSource = 'github' }: Readonly<{ imageField: 'image' | 'imageUrl'; initialSource?: 'github' | 'image' }>) {
  const [sourceType, setSourceType] = useState(initialSource);
  const isRepository = sourceType === 'github';
  return <FieldGroup>
    <Field><FieldLabel htmlFor="source-type">코드 가져올 곳</FieldLabel><Select id="source-type" name="sourceType" value={sourceType} onChange={(event) => { const value = event.target.value; if (value === 'github' || value === 'image') setSourceType(value); }}><option value="github">GitHub / Git 저장소</option><option value="image">빌드된 이미지</option></Select><FieldDescription>로컬 파일을 직접 업로드할 수는 없습니다. 저장소에 코드를 올리거나 빌드한 이미지 주소를 입력하세요.</FieldDescription></Field>
    <fieldset disabled={!isRepository} hidden={!isRepository} className="min-w-0">
      <FieldGroup>
        <Field><FieldLabel htmlFor="repo-url">저장소 URL</FieldLabel><Input id="repo-url" name="repoUrl" type="url" required={isRepository} placeholder="https://github.com/raibit/club-api" /></Field>
        <details>
          <summary className="cursor-pointer rounded-sm py-raibit-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/25">브랜치·빌드 설정 (선택)</summary>
          <FieldGroup className="mt-raibit-md">
            <Field><FieldLabel htmlFor="branch">브랜치</FieldLabel><Input id="branch" name="branch" defaultValue="main" autoCapitalize="none" spellCheck={false} /></Field>
            <Field><FieldLabel htmlFor="dockerfile-path">Dockerfile 경로</FieldLabel><Input id="dockerfile-path" name="dockerfilePath" placeholder="Dockerfile" autoCapitalize="none" spellCheck={false} /><FieldDescription>저장소에 Dockerfile이 있으면 자동으로 사용합니다.</FieldDescription></Field>
            <Field><FieldLabel htmlFor="build-context">빌드 기준 폴더</FieldLabel><Input id="build-context" name="buildContext" defaultValue="." autoCapitalize="none" spellCheck={false} /></Field>
          </FieldGroup>
        </details>
      </FieldGroup>
    </fieldset>
    <fieldset disabled={isRepository} hidden={isRepository} className="min-w-0">
      <Field><FieldLabel htmlFor="service-image">이미지 주소</FieldLabel><Input id="service-image" name={imageField} required={!isRepository} placeholder="registry.example.com/team/web:tag" autoCapitalize="none" spellCheck={false} /></Field>
    </fieldset>
  </FieldGroup>;
}
