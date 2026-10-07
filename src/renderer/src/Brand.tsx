export function BrandMark({ size = 28 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <path
        d="M32 10.144a16 16 0 1 0 0 27.712"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle cx="40" cy="18" r="3.5" fill="currentColor" />
      <circle cx="24" cy="24" r="4" fill="currentColor" opacity=".5" />
    </svg>
  )
}

export default function Brand(): React.JSX.Element {
  return (
    <div className="meeting-brand">
      <span className="brand-mark">
        <BrandMark />
      </span>
      consortium
    </div>
  )
}
