import type { ComponentType } from 'react';
import { IconBriefcase, IconCog, IconFile, IconFlow, IconGrid, IconHome, IconLayers, IconRule, IconShield } from '../components/Icons';
import { CREDIT_ROLES } from '../auth';

export interface NavItem { to: string; label: string; icon: ComponentType<{ size?: number }>; roles?: string[]; end?: boolean }
export interface NavGroup { key: string; label: string; icon: ComponentType<{ size?: number }>; items: NavItem[] }

const ADMIN_READ = ['config_admin', 'auditor'];

/** Navigation; items are shown only to users holding one of `roles` (no roles = everyone). */
export const NAV: NavGroup[] = [
  { key: 'overview', label: 'Overview', icon: IconGrid, items: [{ to: '/', label: 'Dashboard', icon: IconHome, end: true }] },
  { key: 'credit', label: 'Credit', icon: IconBriefcase, items: [{ to: '/requests', label: 'Credit Requests', icon: IconFile, roles: CREDIT_ROLES }] },
  {
    key: 'admin', label: 'Administration', icon: IconCog, items: [
      { to: '/admin/fields', label: 'Field Library', icon: IconLayers, roles: ADMIN_READ },
      { to: '/admin/config', label: 'Configuration', icon: IconCog, roles: ADMIN_READ },
      { to: '/admin/rules', label: 'Rules', icon: IconRule, roles: ADMIN_READ },
      { to: '/admin/workflows', label: 'Workflows', icon: IconFlow, roles: ADMIN_READ },
      { to: '/admin/audit', label: 'Audit Trail', icon: IconShield, roles: ADMIN_READ },
    ],
  },
];

export function visibleNav(hasRole: (...r: string[]) => boolean): NavGroup[] {
  return NAV.map(g => ({ ...g, items: g.items.filter(i => !i.roles || hasRole(...i.roles)) })).filter(g => g.items.length > 0);
}
