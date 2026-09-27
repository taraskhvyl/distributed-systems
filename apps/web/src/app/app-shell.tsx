import { LogOut, type LucideIcon, SquarePlus, SquareTerminal } from 'lucide-react'
import { cn } from '@/components/ui/utils'
import { NAV_PAGES, type PageId } from './pages'

interface AppShellProps {
  page: PageId
  onNavigate: (page: PageId) => void
  onCreate: () => void
  onOpenLog: () => void
  onLogout: () => void
  children: React.ReactNode
}

/** Instagram's frame: a left sidebar on desktop, a bottom bar on mobile. Navigation only. */
export function AppShell({ page, onNavigate, onCreate, onOpenLog, onLogout, children }: AppShellProps) {
  const pageItems = NAV_PAGES.map((navPage) => (
    <NavItem
      key={navPage.id}
      icon={navPage.icon}
      label={navPage.label}
      active={page === navPage.id}
      onClick={() => onNavigate(navPage.id)}
    />
  ))
  const createItem = <NavItem icon={SquarePlus} label="Create" onClick={onCreate} />

  return (
    <div className="min-h-svh md:pl-60">
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r px-3 py-8 md:flex">
        <span className="mb-8 px-3 font-serif text-2xl italic">mediashare</span>
        <nav className="flex flex-1 flex-col gap-1">
          {pageItems}
          {createItem}
        </nav>
        <NavItem icon={SquareTerminal} label="Log" onClick={onOpenLog} />
        <NavItem icon={LogOut} label="Log out" onClick={onLogout} />
      </aside>

      <main className="px-4 pt-6 pb-20 md:pb-10">{children}</main>

      <nav className="fixed inset-x-0 bottom-0 flex justify-around border-t bg-background py-2 md:hidden">
        {pageItems}
        {createItem}
        <NavItem icon={SquareTerminal} label="Log" onClick={onOpenLog} />
      </nav>
    </div>
  )
}

interface NavItemProps {
  icon: LucideIcon
  label: string
  active?: boolean
  onClick: () => void
}

function NavItem({ icon: Icon, label, active = false, onClick }: NavItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      aria-label={label}
      className={cn('flex items-center gap-4 rounded-lg p-3 hover:bg-accent', active && 'font-bold')}
    >
      <Icon className="size-6" strokeWidth={active ? 2.5 : 2} />
      <span className="hidden md:inline">{label}</span>
    </button>
  )
}
