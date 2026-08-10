import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';

export interface Location {
  id: string;
  name: string;
  code: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  timezone: string | null;
  phone: string | null;
  manager_id: string | null;
  manager?: { id: string; first_name: string; last_name: string } | null;
  _count?: { members: number };
}

export type LocationInput = Omit<Location, 'id' | 'manager' | '_count'>;

export function useLocations() {
  return useQuery<Location[]>({
    queryKey: ['locations'],
    queryFn: () => api.get('/api/locations').then((r) => r.data),
  });
}

export function useCreateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (d: Partial<LocationInput>) => api.post('/api/locations', d).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

export function useUpdateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...d }: { id: string } & Partial<LocationInput>) =>
      api.patch(`/api/locations/${id}`, d).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

export function useDeleteLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/locations/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}
