import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

marked.setOptions({ gfm: true, breaks: true })
// Creators indent paragraphs with spaces/tabs; CommonMark would turn those into unwrapped code
// blocks that overflow the story columns. Render indented "code" as ordinary paragraphs instead
// (fenced ``` blocks are still code).
marked.use({
  renderer: {
    code(token) {
      if (token.codeBlockStyle !== 'indented') return false
      return token.text
        .split(/\n\s*\n/)
        .map((para) => `<p>${marked.parseInline(para, { async: false })}</p>`)
        .join('')
    },
  },
})

/** Creator-written story: Markdown → sanitized HTML (no scripts, styles or iframes). */
export function Markdown({ source, className, style }: { source: string; className?: string; style?: React.CSSProperties }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(source, { async: false }), {
        ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'a', 'img', 'blockquote', 'code', 'pre', 'hr'],
        ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
      }),
    [source],
  )
  return <div className={`np-prose ${className ?? ''}`} style={style} dangerouslySetInnerHTML={{ __html: html }} />
}
