import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function Markdown({
  text,
  className = '',
  components
}: {
  text: string
  className?: string
  components?: Components
}): React.JSX.Element {
  return (
    <div className={`prose ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
