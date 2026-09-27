import { Home, type LucideIcon, Search, SquareUser } from 'lucide-react'

export type PageId = 'feed' | 'people' | 'profile'

export interface NavPage {
  id: PageId
  label: string
  icon: LucideIcon
}

/** The pages you can navigate to; "Create" and "Log" open dialogs instead. */
export const NAV_PAGES: NavPage[] = [
  { id: 'feed', label: 'Home', icon: Home },
  { id: 'people', label: 'Search', icon: Search },
  { id: 'profile', label: 'Profile', icon: SquareUser },
]
