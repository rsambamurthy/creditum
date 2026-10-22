import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { useAuth, useMe } from '../auth';
import { initials, humanize } from '../format';
import { IconChevron, IconHelp, IconLogout, IconMenu, IconSearch } from '../components/Icons';
import { visibleNav, type NavGroup } from './nav';
import { CrumbProvider, type Crumb } from './crumbs';
import { HelpPanel } from './HelpPanel';
import { Wordmark } from '../components/Wordmark';

const RAIL_KEY = 'creditum.nav.rail';
const GROUPS_KEY = 'creditum.nav.closed';

function readPref(key: string): string | null { try { return window.localStorage.getItem(key); } catch { return null; } }
function writePref(key: string, v: string) { try { window.localStorage.setItem(key, v); } catch { /* per-viewer convenience only */ } }

function isNarrow() { return typeof window !== 'undefined' && window.matchMedia('(max-width: 900px)').matches; }

export function AppFrame() {
  const me = useMe();
  const { signOut, hasRole } = useAuth();
  const location = useLocation();
  const [rail, setRail] = useState(() => readPref(RAIL_KEY) === '1');
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [closed, setClosed] = useState<string[]>(() => { try { return JSON.parse(readPref(GROUPS_KEY) ?? '[]') as string[]; } catch { return []; } });
  const groups = visibleNav(hasRole);

  useEffect(() => { setMenuOpen(false); }, [location.pathname]);
  const setCrumbsStable = useCallback((c: Crumb[]) => setCrumbs(c), []);
  const closeHelp = useCallback(() => setHelpOpen(false), []);

  const toggleMenu = () => {
    if (isNarrow()) setMenuOpen(o => !o);
    else setRail(r => { writePref(RAIL_KEY, r ? '0' : '1'); return !r; });
  };
  const toggleGroup = (key: string) => setClosed(c => {
    const next = c.includes(key) ? c.filter(k => k !== key) : [...c, key];
    writePref(GROUPS_KEY, JSON.stringify(next));
    return next;
  });

  const roleText = me.roles.map(humanize).join(' · ');
  const isActive = (g: NavGroup) => g.items.some(i => (i.end ? location.pathname === i.to : location.pathname.startsWith(i.to)));

  return (
    <div className={`af${rail ? ' af-rail' : ''}${menuOpen ? ' af-menu-open' : ''}`}>
      <a href="#main" className="sr-only">Skip to content</a>
      <header className="af-header">
        <button type="button" className="af-hbtn" onClick={toggleMenu} aria-label={rail ? 'Expand navigation' : 'Collapse navigation'}
          aria-expanded={isNarrow() ? menuOpen : !rail} aria-controls="af-side"><IconMenu size={18} /></button>
        <Link to="/" className="af-brand" aria-label="Creditum home"><Wordmark light /></Link>
        <span className="af-chip" title={`Workspace: ${me.tenant.name ?? me.tenant.code}`}><span>{me.tenant.name ?? me.tenant.code}</span></span>
        <span className="af-spacer" />
        <div className="af-search" title="Ask Creditum — coming soon">
          <IconSearch size={14} />
          <label htmlFor="af-ask" className="sr-only">Ask Creditum (coming soon)</label>
          <input id="af-ask" type="search" placeholder="Ask Creditum…" disabled aria-describedby="af-ask-soon" />
          <span className="af-soon" id="af-ask-soon">Coming soon</span>
        </div>
        <div className="af-actions">
          <button type="button" className="af-hbtn" aria-label="Help" title="Help" onClick={() => setHelpOpen(true)}><IconHelp size={18} /></button>
          <button type="button" className="af-hbtn" aria-label="Sign out" title="Sign out" onClick={() => signOut('user')}><IconLogout size={18} /></button>
          <span className="af-user-chip" title={`${me.displayName} — ${roleText}`}>
            <span className="af-avatar" aria-hidden="true">{initials(me.displayName)}</span>
            <span className="af-user-text">
              <span className="af-user-name">{me.displayName}</span>
              <span className="af-user-role">{roleText}</span>
            </span>
          </span>
        </div>
      </header>

      <div className="af-body">
        <aside className="af-side" id="af-side" aria-label="Main navigation">
          <div className="af-sb-head">Navigation</div>
          <nav className="af-nav">
            {groups.map(g => {
              const open = !closed.includes(g.key) || rail;
              const GIcon = g.icon;
              return (
                <div key={g.key} className={`af-mg${open ? ' open' : ''}${isActive(g) ? ' has-active' : ''}`}>
                  {!rail && (
                    <button type="button" className="af-mg-h" aria-expanded={open} aria-controls={`nav-${g.key}`} onClick={() => toggleGroup(g.key)}>
                      <span className="af-mg-ic"><GIcon size={12} /></span>
                      <span className="af-mg-t">{g.label}</span>
                      <span className="af-chev"><IconChevron size={14} /></span>
                    </button>
                  )}
                  {open && (
                    <div className="af-mi-list" id={`nav-${g.key}`}>
                      {g.items.map(i => {
                        const Icon = i.icon;
                        return (
                          <NavLink key={i.to} to={i.to} end={i.end} className={({ isActive: a }) => `af-mi${a ? ' active' : ''}`}
                            title={rail ? i.label : undefined} aria-label={rail ? i.label : undefined}>
                            <Icon size={rail ? 17 : 14} />
                            <span className="af-mi-t">{i.label}</span>
                          </NavLink>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          <div className="af-side-foot"><span>Powered by <Wordmark size={12} /> · Integratatech.ai Pvt Ltd</span></div>
        </aside>
        {menuOpen && <button type="button" className="af-scrim" aria-label="Close navigation" onClick={() => setMenuOpen(false)} />}

        <main className="af-main" id="main" tabIndex={-1}>
          <nav className="af-crumbs" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={`${c.label}-${i}`} aria-current={i === crumbs.length - 1 ? 'page' : undefined}>
                {c.to && i < crumbs.length - 1 ? <Link to={c.to}>{c.label}</Link> : c.label}
              </span>
            ))}
          </nav>
          <CrumbProvider value={setCrumbsStable}>
            <Outlet />
          </CrumbProvider>
        </main>
      </div>

      <button type="button" className="help-fab" aria-label="Open help" title="Help" onClick={() => setHelpOpen(true)}>?</button>
      {helpOpen && <HelpPanel onClose={closeHelp} />}
    </div>
  );
}
