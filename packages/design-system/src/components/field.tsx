import type { ComponentPropsWithoutRef, ReactNode } from 'react';

import { Icon } from './icon';

/**
 * Field, input, hint, and error.
 *
 * The error is programmatically associated through `aria-describedby` and
 * states the fix rather than the fault (DESIGN.md §10 "Invalid", §13 "Errors").
 * The render-prop exists so the association cannot be forgotten: the caller
 * cannot get an input without the ids the label and error are wired to.
 */
export interface FieldRenderArgs {
  readonly id: string;
  readonly 'aria-describedby': string | undefined;
  readonly 'aria-invalid': true | undefined;
}

export interface FieldProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | null;
  readonly required?: boolean;
  readonly children: (args: FieldRenderArgs) => ReactNode;
  readonly className?: string;
}

export function Field({ id, label, hint, error, required = false, children, className }: FieldProps) {
  const hintId = hint !== undefined ? `${id}-hint` : undefined;
  const errorId = error !== undefined && error !== null ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className={['iz-field', className].filter(Boolean).join(' ')}>
      <label className="iz-field__label" htmlFor={id}>
        {label}
        {required ? <span className="iz-field__required"> (required)</span> : null}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': errorId !== undefined ? true : undefined,
      })}
      {hint !== undefined ? (
        <p className="iz-field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {errorId !== undefined ? (
        <p className="iz-field__error" id={errorId}>
          <Icon name="warning" size={12} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends Omit<ComponentPropsWithoutRef<'input'>, 'id'> {
  readonly id: string;
}

export function Input({ id, className, ...rest }: InputProps) {
  return <input {...rest} id={id} className={['iz-input', className].filter(Boolean).join(' ')} />;
}
