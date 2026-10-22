import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { IconClose } from '../components/Icons';

const TOPICS: { match: RegExp; title: string; points: string[] }[] = [
  { match: /^\/requests\/new/, title: 'Creating a credit request', points: [
    'Choose the request type and currency — both lists come from your workspace configuration.',
    'Enter the requested amount as typed; it is kept exactly as a decimal, within the currency’s decimal places.',
    'Above the configured amount, the client request details become mandatory. The rule tells you when.',
    'The request is saved as a draft. Submit it from the request page when it is ready.'] },
  { match: /^\/requests\/[^/]+/, title: 'Working a credit request', points: [
    'The Actions card lists only the steps your role may take at the current stage.',
    'Some steps require remarks; they are stored in the workflow history and the audit trail.',
    'Approvals follow the delegated authority level calculated from the base-currency amount.',
    'If someone else changed the request while you were looking at it, reload before acting.'] },
  { match: /^\/requests/, title: 'Credit requests', points: [
    'Use the status tiles to filter; search matches number, borrower and reference.',
    'Amounts are shown in the request currency and in the workspace base currency.'] },
  { match: /^\/admin\/fields/, title: 'Field library', points: [
    'The Creditum Core Field Library plus your workspace’s own custom fields.',
    'Overrides change the label, requirement, visibility or help text for your workspace only.',
    'Where maker-checker is enabled, a second administrator must approve each change.'] },
  { match: /^\/admin\/config/, title: 'Configuration', points: [
    'Parameters, currencies, value lists and the delegated authority matrix are workspace configuration — no code change is needed.',
    'Pending changes wait for a second administrator; the maker cannot approve their own change.'] },
  { match: /^\/admin\/rules/, title: 'Rules', points: [
    'Rules are condition → action pairs stored as data. Thresholds are read from configuration with {"cfg": "…"}.',
    'Use the tester to try a rule against a sample record before saving it.'] },
  { match: /^\/admin\/workflows/, title: 'Workflows', points: [
    'Each request type has its own state machine: states, transitions, the roles allowed and segregation-of-duties flags.',
    'Changes are validated (undefined or unreachable states are rejected) before they are accepted.'] },
  { match: /^\/admin\/audit/, title: 'Audit trail', points: [
    'Every business and configuration change is recorded in an append-only, hash-chained log.',
    'Verify chain recomputes every hash and reports the first break, if any.'] },
  { match: /.*/, title: 'Creditum', points: [
    'Your dashboard shows requests by status and the requests waiting for you.',
    'Use the side navigation to move between credit work and administration.'] },
];

export function HelpPanel({ onClose }: { onClose: () => void }) {
  const { pathname } = useLocation();
  const topic = TOPICS.find(t => t.match.test(pathname))!;
  const closeBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeBtn.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <>
      <button type="button" className="help-backdrop" aria-label="Close help" onClick={onClose} tabIndex={-1} />
      <aside className="help-panel" role="dialog" aria-modal="false" aria-labelledby="help-title">
        <div className="help-head">
          <span className="help-mark" aria-hidden="true">?</span>
          <strong id="help-title">Help</strong>
          <button ref={closeBtn} type="button" className="icon-btn" aria-label="Close help" onClick={onClose}><IconClose /></button>
        </div>
        <div className="help-body help-article">
          <p className="help-sec">On this page</p>
          <h2 style={{ fontSize: 17 }}>{topic.title}</h2>
          <ul>{topic.points.map(p => <li key={p}>{p}</li>)}</ul>
          <p className="help-tip">Ask Creditum — natural-language questions about your portfolio — is coming soon.</p>
        </div>
        <div className="help-foot">Creditum · Integratatech.ai Pvt Ltd</div>
      </aside>
    </>
  );
}
