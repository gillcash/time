export function FormInput({
  label,
  name,
  type = 'text',
  value,
  onChange,
  onBlur,
  placeholder,
  required = false,
  error,
  inputMode,
  pattern,
  min,
  max,
  step
}) {
  const handleChange = (e) => {
    let newValue = e.target.value;

    // Handle number inputs
    if (type === 'number' && newValue !== '') {
      newValue = parseFloat(newValue);
      if (isNaN(newValue)) newValue = '';
    }

    onChange(name, newValue);
  };

  return (
    <div class="form-group">
      {label && (
        <label class={`form-label ${required ? 'required' : ''}`} for={name}>
          {label}
        </label>
      )}
      <input
        id={name}
        name={name}
        type={type}
        class={`form-input ${error ? 'error' : ''}`}
        value={value ?? ''}
        onInput={handleChange}
        onBlur={onBlur}
        placeholder={placeholder}
        inputMode={inputMode}
        pattern={pattern}
        min={min}
        max={max}
        step={step}
      />
      {error && <div class="error-message">{error}</div>}
    </div>
  );
}
