import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

type UserAvatarProps = Readonly<{
  avatarUrl?: string | null;
  className?: string;
  email?: string | null;
  name?: string | null;
  size?: 'default' | 'sm' | 'lg';
}>;

function avatarInitials(name?: string | null, email?: string | null): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 1) {
    return (words[0][0] + words.at(-1)![0]).toLocaleUpperCase('ko-KR');
  }
  const source = words[0] || email?.split('@')[0]?.trim() || '?';
  return Array.from(source)[0]?.toLocaleUpperCase('ko-KR') || '?';
}

export function UserAvatar({ avatarUrl, className, email, name, size = 'default' }: UserAvatarProps) {
  const label = name?.trim() || email?.trim() || '로그인 사용자';
  return (
    <Avatar className={cn('bg-muted', className)} size={size} data-user-avatar>
      {avatarUrl ? <AvatarImage alt={label + ' 프로필 사진'} src={avatarUrl} /> : null}
      <AvatarFallback aria-label={label}>{avatarInitials(name, email)}</AvatarFallback>
    </Avatar>
  );
}
