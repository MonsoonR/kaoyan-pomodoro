import { Check, ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

export type AppSelectOption<T extends string | number> = {
  value: T;
  label: string;
};

type AppSelectProps<T extends string | number> = {
  label: string;
  value: T;
  options: readonly AppSelectOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
  labelClassName?: string;
};

export function AppSelect<T extends string | number>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className = '',
  labelClassName = '',
}: AppSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const listboxId = useId();
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    const closeWhenOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeWhenOutside);
    return () => document.removeEventListener('pointerdown', closeWhenOutside);
  }, []);

  const choose = (next: T) => {
    onChange(next);
    setOpen(false);
  };

  const moveSelection = (offset: number) => {
    if (!options.length) return;
    const nextIndex = (selectedIndex + offset + options.length) % options.length;
    const nextOption = options[nextIndex];
    if (nextOption) onChange(nextOption.value);
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      moveSelection(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setOpen(true);
      const nextOption = options[event.key === 'Home' ? 0 : options.length - 1];
      if (nextOption) onChange(nextOption.value);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen((current) => !current);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  };

  return <div ref={rootRef} className={['field', 'app-select', className].filter(Boolean).join(' ')}>
    <span id={labelId} className={labelClassName}>{label}</span>
    <button
      className="app-select__trigger"
      type="button"
      aria-labelledby={labelId}
      aria-haspopup="listbox"
      aria-controls={listboxId}
      aria-expanded={open}
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
      onKeyDown={onTriggerKeyDown}
    >
      <span>{selected?.label ?? label}</span>
      <ChevronDown className="app-select__chevron" size={17} aria-hidden="true" />
    </button>
    {open ? <div id={listboxId} className="app-select__menu" role="listbox" aria-labelledby={labelId}>
      {options.map((option) => {
        const isSelected = option.value === value;
        return <button
          key={String(option.value)}
          className={isSelected ? 'app-select__option app-select__option--selected' : 'app-select__option'}
          type="button"
          role="option"
          aria-selected={isSelected}
          onClick={() => choose(option.value)}
        >
          <span>{option.label}</span>
          {isSelected ? <Check size={16} aria-hidden="true" /> : null}
        </button>;
      })}
    </div> : null}
  </div>;
}
