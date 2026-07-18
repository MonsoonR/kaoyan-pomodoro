type BrandProps = {
  className?: string;
  inverse?: boolean;
  onActivate?: () => void;
  showTagline?: boolean;
};

export function Brand({
  className = '',
  inverse = false,
  onActivate,
  showTagline = true,
}: BrandProps) {
  const content = <>
    <img className="brand__mark" src="/logo.svg" alt="" />
    <span className="brand__copy">
      <strong>考研番茄钟</strong>
      {showTagline ? <small>FOCUS · REST · RETURN</small> : null}
    </span>
  </>;
  const classes = ['brand', inverse ? 'brand--inverse' : '', className]
    .filter(Boolean)
    .join(' ');

  return onActivate
    ? <button className={classes} type="button" onClick={onActivate} aria-label="返回首页">{content}</button>
    : <div className={classes}>{content}</div>;
}
