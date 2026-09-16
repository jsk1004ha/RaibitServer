'use client';

import { FileTextIcon, UploadIcon, XIcon } from 'lucide-react';
import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { CardContent, CardFooter } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const MAX_ENV_FILE_BYTES = 256 * 1024;
const ENV_FILE_INPUT_ID = 'environment-file-input';

type EnvFileImportProps = Readonly<{
  action: string;
  returnTo: string;
}>;

function supportsEnvironmentFile(file: File): boolean {
  const name = file.name.toLocaleLowerCase('en-US');
  return name === '.env'
    || name.startsWith('.env.')
    || name.endsWith('.env')
    || name.endsWith('.txt');
}

export function EnvFileImport({ action, returnTo }: EnvFileImportProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  async function importFile(file: File): Promise<void> {
    if (file.size > MAX_ENV_FILE_BYTES) {
      setError('파일은 256 KB 이하여야 합니다.');
      return;
    }
    if (!supportsEnvironmentFile(file)) {
      setError('.env 또는 .txt 텍스트 파일만 가져올 수 있습니다.');
      return;
    }
    try {
      const nextContent = await file.text();
      setContent(nextContent);
      setFileName(file.name);
      setError(null);
    } catch {
      setError('파일을 읽지 못했습니다. 파일을 다시 선택해 주세요.');
    }
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.currentTarget.files?.[0];
    if (file) void importFile(file);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void importFile(file);
  }

  function clearFileSelection(): void {
    if (inputRef.current) inputRef.current.value = '';
    setFileName(null);
    setError(null);
  }

  return (
    <form action={action} method="post">
      <input name="_returnTo" type="hidden" value={returnTo} />
      {fileName ? <input name="filename" type="hidden" value={fileName} /> : null}
      <CardContent className="flex flex-col gap-raibit-md">
        <Field>
          <FieldLabel htmlFor={ENV_FILE_INPUT_ID}>.env 파일 선택</FieldLabel>
          <input
            accept=".env,.txt,text/plain"
            className="sr-only"
            id={ENV_FILE_INPUT_ID}
            onChange={handleFileChange}
            ref={inputRef}
            type="file"
          />
          <div
            className={cn(
              'rounded-sm border border-dashed border-border bg-muted/30 p-raibit-lg transition-colors',
              isDragging && 'border-primary bg-primary-soft',
            )}
            data-dragging={isDragging || undefined}
            onDragEnter={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={handleDrop}
          >
            {fileName ? (
              <div className="flex min-w-0 items-center justify-between gap-raibit-md">
                <span className="flex min-w-0 items-center gap-raibit-sm">
                  <FileTextIcon aria-hidden="true" data-icon="inline-start" />
                  <strong className="truncate text-sm font-medium">{fileName}</strong>
                </span>
                <Button aria-label="선택한 파일 해제" onClick={clearFileSelection} size="icon-xs" type="button" variant="ghost">
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            ) : (
              <label className="flex cursor-pointer flex-col items-center gap-raibit-sm text-center" htmlFor={ENV_FILE_INPUT_ID}>
                <UploadIcon aria-hidden="true" data-icon="inline-start" />
                <span className="text-sm font-medium">파일을 끌어놓거나 선택하세요</span>
                <small className="text-muted-foreground">.env 또는 .txt · 최대 256 KB</small>
              </label>
            )}
          </div>
          <FieldDescription>파일은 브라우저에서 텍스트로 읽은 뒤 아래 내용으로 안전하게 전송됩니다.</FieldDescription>
        </Field>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <Field>
          <FieldLabel htmlFor="environment-content">.env 내용</FieldLabel>
          <Textarea
            autoComplete="off"
            id="environment-content"
            name="content"
            onChange={(event) => setContent(event.currentTarget.value)}
            placeholder={'NODE_ENV=production\nAPI_TOKEN=your-secret'}
            required
            rows={8}
            value={content}
          />
          <FieldDescription>붙여넣거나 파일로 불러온 내용은 URL에 포함되지 않습니다.</FieldDescription>
        </Field>
      </CardContent>
      <CardFooter className="mt-raibit-xl justify-end">
        <Button type="submit" variant="outline">.env 가져오기</Button>
      </CardFooter>
    </form>
  );
}
