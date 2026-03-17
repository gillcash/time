export function SubmitButton({
  label = 'Submit',
  disabled = false,
  loading = false,
  onClick
}) {
  return (
    <button
      type="submit"
      class="submit-btn"
      disabled={disabled || loading}
      onClick={onClick}
    >
      {loading ? 'Submitting...' : label}
    </button>
  );
}
