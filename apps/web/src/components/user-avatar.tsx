import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/components/ui/utils'

/** No profile pictures in this app: the avatar is the username's first letter. */
export function UserAvatar({ username, className }: { username: string; className?: string }) {
  return (
    <Avatar className={cn('size-8', className)}>
      <AvatarFallback className="bg-gradient-to-tr from-amber-400 via-pink-500 to-purple-600 text-[length:inherit] font-semibold text-white uppercase">
        {username.charAt(0)}
      </AvatarFallback>
    </Avatar>
  )
}
