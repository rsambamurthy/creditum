import { useNavigate } from 'react-router-dom';
import { api, type CreditRequestInput } from '../api';
import { useCrumbs } from '../layout/crumbs';
import { PageHead } from '../components/Feedback';
import { RequestForm } from '../components/RequestForm';
import { useToast } from '../components/Toast';

export function NewRequestPage() {
  useCrumbs([{ label: 'Credit' }, { label: 'Credit Requests', to: '/requests' }, { label: 'New request' }]);
  const navigate = useNavigate();
  const toast = useToast();
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <PageHead title="New credit request" subtitle="Saved as a draft. You can submit it for credit review from the request page." />
      <RequestForm submitLabel="Save draft" onCancel={() => navigate('/requests')}
        onSubmit={async input => {
          const res = await api.createRequest(input as CreditRequestInput);
          toast.show(`${res.request.requestNumber} saved as ${res.request.statusLabel}`, 'ok');
          navigate(`/requests/${res.request.id}`, { state: { warnings: res.warnings } });
          return res.warnings;
        }} />
    </div>
  );
}
