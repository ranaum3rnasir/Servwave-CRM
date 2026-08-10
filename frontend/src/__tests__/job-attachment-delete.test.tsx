import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from 'vitest';
import api from '@/lib/axios';
import { AttachmentsTabBody } from '@/pages/JobDetailPage';
import { JobFilesCard } from '@/components/jobs/overview/JobFilesCard';

// @/lib/axios is globally mocked in src/__tests__/setup.ts

const PHOTO = {
  id: 'att-photo',
  file_name: 'panel.png',
  file_url: 'https://files.test/panel.png',
  file_type: 'image/png',
  display_name: 'Panel',
  context: 'JOB_WORK',
  source: null,
};

const DOC = {
  id: 'att-doc',
  file_name: 'permit.pdf',
  file_url: 'https://files.test/permit.pdf',
  file_type: 'application/pdf',
  display_name: 'Permit',
  context: 'JOB_WORK',
  source: null,
};

/** Forwarded in from the lead via `include_walkthrough=true` - job must not delete it. */
const WALKTHROUGH_PHOTO = {
  id: 'att-wt',
  file_name: 'site.png',
  file_url: 'https://files.test/site.png',
  file_type: 'image/png',
  display_name: 'Site visit',
  context: 'WALKTHROUGH',
  source: 'WALKTHROUGH',
};

function renderWithClient(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.delete).mockClear();
  vi.mocked(api.delete).mockResolvedValue({ data: {} });
});

/** Click the trash affordance, then answer the app's ConfirmDialog. */
async function deleteViaDialog(triggerName: RegExp, answer: 'Delete' | 'Cancel') {
  fireEvent.click(screen.getByRole('button', { name: triggerName }));
  await userEvent.click(await screen.findByRole('button', { name: answer }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Attachments tab', () => {
  it('deletes a photo via DELETE /api/attachments/job/:jobId/:attachmentId', async () => {
    renderWithClient(<AttachmentsTabBody jobId="job-1" attachments={[PHOTO]} />);

    await deleteViaDialog(/delete panel/i, 'Delete');

    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.delete).mock.calls[0][0]).toBe('/api/attachments/job/job-1/att-photo');
  });

  it('deletes a document too', async () => {
    renderWithClient(<AttachmentsTabBody jobId="job-1" attachments={[DOC]} />);

    await deleteViaDialog(/delete permit/i, 'Delete');

    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.delete).mock.calls[0][0]).toBe('/api/attachments/job/job-1/att-doc');
  });

  it('does not fire the request when the confirm is dismissed', async () => {
    renderWithClient(<AttachmentsTabBody jobId="job-1" attachments={[PHOTO]} />);

    await deleteViaDialog(/delete panel/i, 'Cancel');

    expect(api.delete).not.toHaveBeenCalled();
  });

  it('prompts with the app dialog, never the browser confirm', async () => {
    const browserConfirm = vi.spyOn(window, 'confirm');
    renderWithClient(<AttachmentsTabBody jobId="job-1" attachments={[PHOTO]} />);

    fireEvent.click(screen.getByRole('button', { name: /delete panel/i }));

    expect(await screen.findByText('Delete "Panel"?')).toBeInTheDocument();
    expect(browserConfirm).not.toHaveBeenCalled();
  });

  it('offers no delete control on walkthrough files (they belong to the lead)', () => {
    renderWithClient(<AttachmentsTabBody jobId="job-1" attachments={[WALKTHROUGH_PHOTO]} />);

    expect(screen.getByText('Site visit')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete site visit/i })).toBeNull();
  });

  it('keeps the delete control out of the anchor (no interactive nesting)', () => {
    renderWithClient(<AttachmentsTabBody jobId="job-1" attachments={[PHOTO]} />);

    const button = screen.getByRole('button', { name: /delete panel/i });
    expect(button.closest('a')).toBeNull();
  });
});

describe('Overview files card', () => {
  it('deletes a photo from the overview grid', async () => {
    renderWithClient(<JobFilesCard jobId="job-1" attachments={[PHOTO]} />);

    await deleteViaDialog(/delete panel/i, 'Delete');

    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.delete).mock.calls[0][0]).toBe('/api/attachments/job/job-1/att-photo');
  });

  it('deletes a document row from the overview card', async () => {
    renderWithClient(<JobFilesCard jobId="job-1" attachments={[DOC]} />);

    await deleteViaDialog(/delete permit/i, 'Delete');

    await waitFor(() => expect(api.delete).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.delete).mock.calls[0][0]).toBe('/api/attachments/job/job-1/att-doc');
  });

  it('offers no delete control on walkthrough files', () => {
    renderWithClient(<JobFilesCard jobId="job-1" attachments={[WALKTHROUGH_PHOTO]} />);

    expect(screen.queryByRole('button', { name: /delete site visit/i })).toBeNull();
  });
});
