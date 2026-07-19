type BrandProps = {
  className?: string;
  inverse?: boolean;
  onActivate?: () => void;
};

export function Brand({
  className = '',
  inverse = false,
  onActivate,
}: BrandProps) {
  const content = <>
    <img className="brand__mark" src="/logo.svg" alt="" />
    <span className="brand__copy">
      <strong>一事</strong>
    </span>
  </>;
  const classes = ['brand', inverse ? 'brand--inverse' : '', className]
    .filter(Boolean)
    .join(' ');

  return onActivate
    ? <button className={classes} type="button" onClick={onActivate} aria-label="返回首页">{content}</button>
    : <div className={classes}>{content}</div>;
}
