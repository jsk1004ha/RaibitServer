'use client';

import { useRef, useState } from 'react';
import { Button } from './ui/button';
import { Field, FieldGroup, FieldLabel } from './ui/field';
import { Input } from './ui/input';

export function EmailVerificationForm({ initialEmail, next, messageId, verifyAction, resendAction }: Readonly<{
  initialEmail: string;
  next: string;
  messageId?: string;
  verifyAction: string;
  resendAction: string;
}>) {
  const [email, setEmail] = useState(initialEmail);
  const emailInput = useRef<HTMLInputElement>(null);
  const resendReturnTo = `/login?${new URLSearchParams({ mode: 'verify', email, next })}`;

  return <>
    <form method="post" action={verifyAction} className="auth-form">
      <input name="_returnTo" type="hidden" value={next} />
      <FieldGroup>
        <Field><FieldLabel htmlFor="verify-email">이메일</FieldLabel><Input aria-describedby={messageId} autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} ref={emailInput} id="verify-email" name="email" required type="email" /></Field>
        <Field><FieldLabel htmlFor="verify-code">6자리 인증 코드</FieldLabel><Input aria-describedby={messageId} id="verify-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></Field>
        <Button type="submit">인증하고 계속하기</Button>
      </FieldGroup>
    </form>
    <form method="post" action={resendAction} className="auth-resend" onSubmit={(event) => {
      if (!emailInput.current?.reportValidity()) event.preventDefault();
    }}>
      <input name="_returnTo" type="hidden" value={resendReturnTo} />
      <input name="email" type="hidden" value={email} />
      <Button type="submit" variant="outline">인증 코드 다시 보내기</Button>
    </form>
  </>;
}
