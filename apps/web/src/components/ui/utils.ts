import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Joins class names; later Tailwind classes win over conflicting earlier ones (shadcn helper). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
