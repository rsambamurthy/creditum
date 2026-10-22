import { Link } from 'react-router-dom';
import { PageHead } from '../components/Feedback';
import { useCrumbs } from '../layout/crumbs';

export function NotFoundPage() {
  useCrumbs([{ label: 'Not found' }]);
  return (
    <div className="page">
      <PageHead title="Page not found" subtitle="The page you asked for does not exist or has moved." />
      <Link to="/" className="btn btn-primary">Go to dashboard</Link>
    </div>
  );
}
