import type { Supporter } from '@nampu/types'
import { Avatar } from '@nampu/ui'
import { useQuery } from '@tanstack/react-query'
import { useI18n } from '../lib/i18n'
import { loadProfile, profileName, profilePicture } from '../lib/nostr'

/**
 * Name + picture for a supporter row. A supporter who proved a Nostr pubkey is shown with
 * their current kind-0 profile; until it loads (or if relays have none) the stored name is used.
 */
export function useSupporterIdentity(s: Supporter) {
  const { t } = useI18n()
  const profile = useQuery({
    queryKey: ['nostr-profile', s.pubkey],
    queryFn: () => loadProfile(s.pubkey!),
    enabled: !!s.pubkey,
    staleTime: 60 * 60_000,
    gcTime: 24 * 60 * 60_000,
  })
  return {
    name: profileName(profile.data) || s.name || t.anonymous,
    picture: profilePicture(profile.data),
  }
}

export function SupporterAvatar({ s, size }: { s: Supporter; size?: number }) {
  const { name, picture } = useSupporterIdentity(s)
  return <Avatar name={name} src={picture} size={size} />
}

export function SupporterName({ s }: { s: Supporter }) {
  return <>{useSupporterIdentity(s).name}</>
}

/** Name, with a small picture in front only when the supporter has a Nostr profile picture. */
export function SupporterChip({ s, size = 20 }: { s: Supporter; size?: number }) {
  const { name, picture } = useSupporterIdentity(s)
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 align-middle">
      {picture && <Avatar name={name} src={picture} size={size} />}
      <span className="truncate">{name}</span>
    </span>
  )
}
