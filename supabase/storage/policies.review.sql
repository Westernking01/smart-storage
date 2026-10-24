-- LOCAL REVIEW ONLY. Never provision by writing Storage system-table rows.
-- Existing feasibility resources/policies are untouched. Terminal rollback is intentional.
begin;
do $$ begin raise exception 'REVIEW_ONLY_NOT_AUTHORIZED'; end $$;
create policy ss_private_ready_read on storage.objects for select to authenticated using (
  bucket_id='smart-storage-private-v1' and
  exists(select 1 from public.files f where f.owner_id=auth.uid() and f.state='ready' and (
    f.manifest_path=name or exists(select 1 from public.file_blocks b join public.transfer_attempts a on a.block_id=b.id
      where b.file_id=f.id and a.state='present' and a.object_path=name)
  )) and storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info'])
);
-- Restrictive denial constrains any accidental permissive ordinary-user write policy.
-- Privileged provider roles/owners may bypass RLS; this is not ADR-041 enforcement.
create policy ss_private_read_boundary on storage.objects as restrictive for select to public using (
  bucket_id<>'smart-storage-private-v1' or (
    exists(select 1 from public.files f where f.owner_id=auth.uid() and f.state='ready' and (
      f.manifest_path=name or exists(select 1 from public.file_blocks b join public.transfer_attempts a on a.block_id=b.id
        where b.file_id=f.id and a.state='present' and a.object_path=name)
    )) and storage.allow_any_operation(array['object.get_authenticated','object.get_authenticated_info'])
  )
);
create policy ss_private_no_insert on storage.objects as restrictive for insert to public with check(bucket_id<>'smart-storage-private-v1');
create policy ss_private_no_update on storage.objects as restrictive for update to public using(bucket_id<>'smart-storage-private-v1') with check(bucket_id<>'smart-storage-private-v1');
create policy ss_private_no_delete on storage.objects as restrictive for delete to public using(bucket_id<>'smart-storage-private-v1');
rollback;
