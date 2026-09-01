import Image from 'next/image';

type BrandMode = 'decorative' | 'informative';

type BrandProps = Readonly<{
  className?: string;
  height: number;
  mode?: BrandMode;
  priority?: boolean;
  sizes?: string;
  width: number;
}>;

export function Brand({
  className,
  height,
  mode = 'decorative',
  priority = false,
  sizes,
  width,
}: BrandProps) {
  const isDecorative = mode === 'decorative';

  return (
    <Image
      alt={isDecorative ? '' : '라이빗(RAIBIT) 로고'}
      aria-hidden={isDecorative || undefined}
      className={className}
      height={height}
      priority={priority}
      sizes={sizes}
      src="/raibit-logo.png"
      width={width}
    />
  );
}
