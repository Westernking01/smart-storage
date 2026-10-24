-- REVIEW CANDIDATE ONLY. Do not deploy without separate authorization.
-- Metadata only: no Storage, quota, transfer, signing or publisher changes.
BEGIN;
CREATE TABLE public.file_folders (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES public.profiles(id),
 parent_id uuid, name text NOT NULL CHECK(octet_length(name) BETWEEN 1 AND 255),
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,owner_id),
 FOREIGN KEY(parent_id,owner_id) REFERENCES public.file_folders(id,owner_id),
 CHECK(parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX file_folders_unique_name ON public.file_folders(owner_id,coalesce(parent_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(name));
CREATE TABLE public.file_locations (
 file_id uuid PRIMARY KEY, owner_id uuid NOT NULL,
 folder_id uuid, revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 FOREIGN KEY(file_id,owner_id) REFERENCES public.files(id,owner_id),
 FOREIGN KEY(folder_id,owner_id) REFERENCES public.file_folders(id,owner_id)
);
CREATE INDEX file_locations_folder ON public.file_locations(owner_id,folder_id,file_id);
ALTER TABLE public.file_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_locations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.file_folders,public.file_locations FROM PUBLIC,anon,authenticated,service_role;
CREATE POLICY folders_owner_read ON public.file_folders FOR SELECT TO authenticated USING(owner_id=auth.uid());
CREATE POLICY locations_owner_read ON public.file_locations FOR SELECT TO authenticated USING(owner_id=auth.uid());

CREATE FUNCTION public.ss_folder_create(p_id uuid,p_parent uuid,p_name text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_owner uuid := app_private.actor(); v_folder public.file_folders; v_depth integer;
BEGIN
 IF p_id IS NULL OR p_id='00000000-0000-0000-0000-000000000000'::uuid OR NOT app_private.valid_name(p_name) OR p_name<>btrim(p_name) THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_owner::text,75130));
 SELECT * INTO v_folder FROM public.file_folders AS d WHERE d.id=p_id AND d.owner_id=v_owner;
 IF FOUND THEN
  IF v_folder.parent_id IS DISTINCT FROM p_parent OR v_folder.name<>p_name THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
 ELSE
  IF p_parent IS NOT NULL THEN
   IF NOT EXISTS(SELECT 1 FROM public.file_folders AS d WHERE d.id=p_parent AND d.owner_id=v_owner) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
   WITH RECURSIVE chain AS (
    SELECT d.id,d.parent_id,1 AS depth FROM public.file_folders AS d WHERE d.id=p_parent AND d.owner_id=v_owner
    UNION ALL SELECT d.id,d.parent_id,c.depth+1 FROM public.file_folders AS d JOIN chain AS c ON d.id=c.parent_id WHERE d.owner_id=v_owner AND c.depth<16
   ) SELECT max(depth) INTO v_depth FROM chain;
   IF v_depth>=16 THEN RAISE EXCEPTION 'FOLDER_LIMIT'; END IF;
  END IF;
  IF (SELECT count(*) FROM public.file_folders AS d WHERE d.owner_id=v_owner)>=256 THEN RAISE EXCEPTION 'FOLDER_LIMIT'; END IF;
  INSERT INTO public.file_folders(id,owner_id,parent_id,name) VALUES(p_id,v_owner,p_parent,p_name) RETURNING * INTO v_folder;
 END IF;
 RETURN jsonb_build_object('id',v_folder.id,'name',v_folder.name,'parentId',v_folder.parent_id,'revision',v_folder.revision,'createdAt',v_folder.created_at);
END $$;

CREATE FUNCTION public.ss_folder_rename(p_id uuid,p_name text,p_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_owner uuid := app_private.actor(); v_folder public.file_folders;
BEGIN
 IF NOT app_private.valid_name(p_name) OR p_name<>btrim(p_name) THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 SELECT * INTO v_folder FROM public.file_folders AS d WHERE d.id=p_id AND d.owner_id=v_owner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF v_folder.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 UPDATE public.file_folders AS d SET name=p_name,revision=d.revision+1 WHERE d.id=p_id AND d.owner_id=v_owner RETURNING * INTO v_folder;
 RETURN jsonb_build_object('id',v_folder.id,'name',v_folder.name,'parentId',v_folder.parent_id,'revision',v_folder.revision,'createdAt',v_folder.created_at);
END $$;

CREATE FUNCTION public.ss_file_move(p_file uuid,p_folder uuid,p_revision bigint) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_owner uuid := app_private.actor(); v_revision bigint;
BEGIN
 PERFORM 1 FROM public.files AS f WHERE f.id=p_file AND f.owner_id=v_owner AND f.state='ready' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 IF p_folder IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.file_folders AS d WHERE d.id=p_folder AND d.owner_id=v_owner) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT l.revision INTO v_revision FROM public.file_locations AS l WHERE l.file_id=p_file AND l.owner_id=v_owner;
 v_revision := coalesce(v_revision,0);
 IF v_revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT'; END IF;
 INSERT INTO public.file_locations(file_id,owner_id,folder_id,revision) VALUES(p_file,v_owner,p_folder,v_revision+1)
 ON CONFLICT(file_id) DO UPDATE SET folder_id=excluded.folder_id,revision=excluded.revision;
 RETURN jsonb_build_object('id',p_file,'folderId',p_folder,'revision',v_revision+1);
END $$;

CREATE FUNCTION public.ss_explorer_list(p_parent uuid DEFAULT NULL,p_query text DEFAULT '',p_sort text DEFAULT 'name',p_offset integer DEFAULT 0) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_owner uuid := app_private.actor(); v_folders jsonb; v_files jsonb; v_breadcrumbs jsonb; v_more boolean;
BEGIN
 IF p_query IS NULL OR octet_length(p_query)>512 OR p_sort IS NULL OR p_sort NOT IN('name','type','size','date') OR p_offset IS NULL OR p_offset NOT BETWEEN 0 AND 100000 THEN RAISE EXCEPTION 'INVALID_INPUT'; END IF;
 IF p_parent IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.file_folders AS d WHERE d.id=p_parent AND d.owner_id=v_owner) THEN RAISE EXCEPTION 'NOT_FOUND'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'name',d.name,'parentId',d.parent_id,'revision',d.revision,'createdAt',d.created_at) ORDER BY lower(d.name),d.id),'[]'::jsonb) INTO v_folders
 FROM public.file_folders AS d WHERE d.owner_id=v_owner AND (CASE WHEN p_query<>'' THEN strpos(lower(d.name),lower(p_query))>0 ELSE d.parent_id IS NOT DISTINCT FROM p_parent END);
 WITH RECURSIVE chain AS (
  SELECT d.*,1 AS depth FROM public.file_folders AS d WHERE d.id=p_parent AND d.owner_id=v_owner
  UNION ALL SELECT d.*,c.depth+1 FROM public.file_folders AS d JOIN chain AS c ON d.id=c.parent_id WHERE d.owner_id=v_owner AND c.depth<16
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'parentId',parent_id,'revision',revision,'createdAt',created_at) ORDER BY depth DESC),'[]'::jsonb) INTO v_breadcrumbs FROM chain;
 WITH selected AS (
  SELECT f.*,l.folder_id,coalesce(l.revision,0) AS location_revision,
   row_number() OVER (ORDER BY CASE WHEN p_sort='name' THEN lower(f.display_name) END,CASE WHEN p_sort='type' THEN coalesce(f.original_mime,'') END,CASE WHEN p_sort='size' THEN f.original_bytes END DESC,CASE WHEN p_sort='date' THEN f.created_at END DESC,f.id) AS position
  FROM public.files AS f LEFT JOIN public.file_locations AS l ON l.file_id=f.id AND l.owner_id=f.owner_id
  WHERE f.owner_id=v_owner AND f.state='ready' AND (CASE WHEN p_query<>'' THEN strpos(lower(f.display_name),lower(p_query))>0 ELSE l.folder_id IS NOT DISTINCT FROM p_parent END)
 ), page AS (SELECT * FROM selected ORDER BY position LIMIT 26 OFFSET p_offset)
 SELECT coalesce(jsonb_agg(jsonb_build_object('file',app_private.file_json(f),'folderId',p.folder_id,'locationRevision',p.location_revision) ORDER BY p.position) FILTER(WHERE p.position<=p_offset+25),'[]'::jsonb),count(*)>25
 INTO v_files,v_more FROM page AS p JOIN public.files AS f ON f.id=p.id AND f.owner_id=v_owner;
 RETURN jsonb_build_object('folders',v_folders,'breadcrumbs',v_breadcrumbs,'files',v_files,'next',CASE WHEN v_more AND p_offset+25<=100000 THEN p_offset+25 ELSE NULL END);
END $$;
REVOKE ALL ON FUNCTION public.ss_folder_create(uuid,uuid,text),public.ss_folder_rename(uuid,text,bigint),public.ss_file_move(uuid,uuid,bigint),public.ss_explorer_list(uuid,text,text,integer) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.ss_folder_create(uuid,uuid,text),public.ss_folder_rename(uuid,text,bigint),public.ss_file_move(uuid,uuid,bigint),public.ss_explorer_list(uuid,text,text,integer) TO authenticated;
COMMIT;
