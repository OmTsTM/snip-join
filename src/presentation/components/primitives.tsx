import { useId, type ButtonHTMLAttributes, type ReactNode } from 'react'

import { Check } from './Icons'

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ')
}

type ButtonTone = 'snip' | 'paper' | 'neutral' | 'quiet' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly tone?: ButtonTone
  readonly size?: 'sm' | 'md' | 'lg'
  readonly icon?: ReactNode
  readonly full?: boolean
}

const TONES: Record<ButtonTone, string> = {
  // Orange is reserved for cutting, so the filled orange button is only ever the
  // one that removes something.
  snip: 'bg-snip text-ink hover:bg-snip-bright active:bg-snip-deep shadow-[0_1px_0_rgba(255,255,255,0.18)_inset,0_6px_18px_-10px_rgba(249,129,30,0.9)]',
  // The finished result, in the logo's own "Join" colour. Highest contrast on
  // screen, so it reads as the primary action without borrowing the cut colour.
  paper: 'bg-paper text-ink hover:bg-white active:bg-paper/90 shadow-[0_6px_20px_-12px_rgba(244,230,214,0.7)]',
  // `control`, not `raised-hi`: a raised surface is lighter than the ground in a
  // dark skin and darker than it in a pale one, so the same token that lifts a
  // button here presses it into the page there. This is the tone for anything
  // that should read as a button without claiming to be the main action.
  neutral: 'bg-control text-paper hover:bg-raised-hi border border-line-bright',
  quiet: 'text-muted hover:text-paper hover:bg-raised',
  // Red, and not a shade of orange: orange is cutting, which is deliberate and
  // undoable, while this is the button that loses work. Tinted rather than
  // filled, so it warns without competing with the action being recommended.
  danger:
    'bg-alarm/12 text-alarm-ink border border-alarm/35 hover:bg-alarm hover:text-white hover:border-alarm',
}

const SIZES = {
  sm: 'h-7 px-2.5 text-[12px] gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-[13px] gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[14px] gap-2.5 rounded-xl font-medium',
} as const

export function Button({
  tone = 'neutral',
  size = 'md',
  icon,
  full,
  className,
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center font-medium whitespace-nowrap',
        'transition-[background-color,color,border-color,transform] duration-150',
        'active:translate-y-px disabled:pointer-events-none disabled:opacity-35',
        SIZES[size],
        TONES[tone],
        full && 'w-full',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string
  readonly active?: boolean
}

/** A square control whose only content is an icon; the label is its tooltip. */
export function IconButton({ label, active, className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cx(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg',
        'transition-colors duration-150 disabled:pointer-events-none disabled:opacity-30',
        active ? 'bg-snip/15 text-snip-ink' : 'text-muted hover:bg-raised hover:text-paper',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  )
}

interface SwitchProps {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: string
  readonly description?: string
  readonly disabled?: boolean
}

/**
 * The join toggle, and the only switch in the application.
 *
 * It carries a description that changes with its state rather than a static
 * hint, because the two states produce genuinely different files and the
 * difference is worth spelling out at the moment of choosing.
 */
export function Switch({ checked, onChange, label, description, disabled }: SwitchProps) {
  const id = useId()

  return (
    <div className="flex items-start gap-3">
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx(
          'relative mt-0.5 h-[22px] w-[38px] shrink-0 rounded-full border transition-colors duration-200',
          'disabled:opacity-40',
          checked
            ? 'border-dusk-lift/60 bg-dusk-lift/25'
            : 'border-line-bright bg-raised',
        )}
      >
        <span
          className={cx(
            'absolute top-[2px] h-[16px] w-[16px] rounded-full transition-[left,background-color] duration-200 ease-[var(--ease-out-soft)]',
            checked ? 'left-[18px] bg-dusk-lift' : 'left-[2px] bg-faint',
          )}
        />
      </button>

      <label htmlFor={id} className="cursor-pointer leading-tight">
        <span className="block text-[13px] font-medium text-paper">{label}</span>
        {description && <span className="mt-1 block text-[12px] text-muted">{description}</span>}
      </label>
    </div>
  )
}

export interface SegmentedOption<T extends string> {
  readonly value: T
  readonly label: string
  readonly note?: string
  readonly disabled?: boolean
}

interface SegmentedProps<T extends string> {
  readonly value: T
  readonly options: readonly SegmentedOption<T>[]
  readonly onChange: (value: T) => void
  readonly ariaLabel: string
}

/** A row of mutually exclusive choices, used wherever a dropdown would hide
 *  options the user should be comparing. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="flex gap-1 rounded-lg border border-line bg-ink/60 p-1"
    >
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            title={option.note}
            onClick={() => onChange(option.value)}
            className={cx(
              'flex-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-colors duration-150',
              'disabled:pointer-events-none disabled:opacity-30',
              selected ? 'bg-raised-hi text-paper' : 'text-muted hover:text-paper',
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

interface FieldProps {
  readonly label: string
  readonly hint?: string | undefined
  readonly children: ReactNode
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <div className="space-y-2">
      <div className="eyebrow">{label}</div>
      {children}
      {hint && <p className="text-[11.5px] leading-snug text-faint">{hint}</p>}
    </div>
  )
}

interface CheckboxProps {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly label: string
  readonly note?: string
}

export function Checkbox({ checked, onChange, label, note }: CheckboxProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-2.5 text-left"
    >
      <span
        className={cx(
          'mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors duration-150',
          checked ? 'border-dusk-lift bg-dusk-lift text-ink' : 'border-line-bright bg-raised',
        )}
      >
        {checked && <Check size={12} strokeWidth={2.6} />}
      </span>
      <span className="leading-tight">
        <span className="block text-[12.5px] text-paper">{label}</span>
        {note && <span className="mt-0.5 block text-[11.5px] text-faint">{note}</span>}
      </span>
    </button>
  )
}

/** A thin progress line. Determinate whenever the backend reports a fraction. */
export function ProgressBar({ value, tone = 'snip' }: { readonly value: number; readonly tone?: 'snip' | 'dusk' }) {
  const percent = Math.round(Math.min(Math.max(value, 0), 1) * 1000) / 10

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="h-1 w-full overflow-hidden rounded-full bg-line"
    >
      <div
        className={cx(
          'h-full rounded-full transition-[width] duration-200 ease-linear',
          tone === 'snip' ? 'bg-snip' : 'bg-dusk-lift',
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}
