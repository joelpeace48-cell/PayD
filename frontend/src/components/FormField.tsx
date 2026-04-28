/**
 * FormField Component
 *
 * A reusable form field wrapper that provides consistent validation feedback,
 * error messages, and accessibility features across the application.
 *
 * Features:
 * - Red border on invalid state
 * - Error message display below input
 * - Accessibility support (aria-invalid, aria-describedby)
 * - Support for required field indicators
 * - Responsive design
 *
 * Issue #106: Improve Form Validation Feedback
 */

import React from 'react';

export interface FormFieldProps {
  /** Unique identifier for the field */
  id: string;

  /** Label text displayed above the input */
  label: string;

  /** Whether the field is required */
  required?: boolean;

  /** Error message to display (if any) */
  error?: string;

  /** Help text displayed below the input (when no error) */
  helpText?: string;

  /** The input element or component */
  children: React.ReactNode;

  /** Additional CSS class for the wrapper */
  className?: string;
}

export const FormField: React.FC<FormFieldProps> = ({
  id,
  label,
  required = false,
  error,
  helpText,
  children,
  className = '',
}) => {
  const hasError = !!error;
  const descriptionId = `${id}-description`;

  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
        {required && (
          <span className="text-danger ml-1" aria-label="required">
            *
          </span>
        )}
      </label>

      <div className={`relative transition-colors ${hasError ? 'border-danger' : 'border-border'}`}>
        {React.isValidElement(children)
          ? // eslint-disable-next-line react-x/no-clone-element
            React.cloneElement(children, {
              id,
              'aria-invalid': hasError,
              'aria-describedby': hasError || helpText ? descriptionId : undefined,
              className: [
                typeof (children.props as Record<string, unknown>).className === 'string'
                  ? (children.props as Record<string, unknown>).className
                  : '',
                hasError ? 'border-danger focus:border-danger focus:ring-danger/20' : '',
              ]
                .filter(Boolean)
                .join(' '),
            } as React.HTMLAttributes<HTMLElement>)
          : children}
      </div>

      {(error || helpText) && (
        <p
          id={descriptionId}
          className={`text-xs ${hasError ? 'text-danger font-medium' : 'text-muted'}`}
        >
          {error || helpText}
        </p>
      )}
    </div>
  );
};

FormField.displayName = 'FormField';
