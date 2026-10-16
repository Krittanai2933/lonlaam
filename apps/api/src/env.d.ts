// Secrets with no value in wrangler.jsonc, so `wrangler types` doesn't see them.
interface Env {
  /** Optional. Enables English machine translation of project text; unset = off. */
  ANTHROPIC_API_KEY?: string
}
