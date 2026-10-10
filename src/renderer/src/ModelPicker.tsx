import { useRef, useState } from 'react'

type Props = {
  value: string
  options: string[]
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
}

// A free-text model field with a scrollable, filtered list of suggestions. Replaces <datalist>,
// whose popup can't scroll in Electron once it is taller than the window (OpenRouter lists hundreds).
export default function ModelPicker({
  value,
  options,
  onChange,
  placeholder,
  disabled
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const list = useRef<HTMLUListElement>(null)
  const q = value.trim().toLowerCase()
  // an exact pick shows everything, so the list can be browsed again; typing filters it
  const shown =
    q && !options.includes(value) ? options.filter((o) => o.toLowerCase().includes(q)) : options
  const pick = (v: string): void => {
    onChange(v)
    setOpen(false)
    setActive(-1)
  }
  const move = (d: number): void => {
    const i = Math.max(0, Math.min(shown.length - 1, active + d))
    setActive(i)
    list.current?.children[i]?.scrollIntoView({ block: 'nearest' })
  }
  return (
    <div className="model-picker">
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open && shown.length > 0}
        aria-autocomplete="list"
        onChange={(e) => {
          onChange(e.target.value)
          setOpen(true)
          setActive(-1)
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setOpen(true)
            move(1)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            move(-1)
          } else if (e.key === 'Enter' && open && shown[active]) {
            e.preventDefault()
            pick(shown[active])
          } else if (e.key === 'Escape') setOpen(false)
        }}
      />
      {open && !disabled && shown.length > 0 && (
        <ul
          ref={list}
          className="model-options"
          role="listbox"
          // keep focus in the input (scrollbar drags included) and stop the wrapping <label>
          // from clicking the input, which would reopen the list right after a pick
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => e.preventDefault()}
        >
          {shown.map((o, i) => (
            <li
              key={o}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : o === value ? 'current' : ''}
              onMouseDown={() => pick(o)}
              onMouseEnter={() => setActive(i)}
            >
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
