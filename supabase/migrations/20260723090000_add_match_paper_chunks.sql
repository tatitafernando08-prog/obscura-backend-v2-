-- Hybrid (vector + full-text) retrieval over paper_chunks, fused via
-- Reciprocal Rank Fusion. Schema-specific to backend-v2: filters against
-- papers.subject/syllabus/level/medium (no `stream` column on papers --
-- stream is a students-only, A/L profile attribute per SPEC-SHEET.md §13,
-- never a paper attribute) and only returns chunks whose paper has finished
-- ingestion (status = 'ready').
create or replace function public.match_paper_chunks(
  query_embedding vector(768),
  query_text      text,
  filter_subject  text default null,
  filter_syllabus text default null,
  filter_level    text default null,
  filter_medium   text default null,
  match_count     int default 8,
  rrf_k           int default 60
)
returns table (
  id                uuid,
  paper_id          uuid,
  content           text,
  chunk_index       int,
  vector_similarity double precision,
  text_rank         double precision,
  score             double precision,
  past_papers       json
)
language plpgsql
as $function$
begin
  return query
  with filtered_papers as (
    select p.id
    from papers p
    where p.status = 'ready'
      and (filter_subject  is null or p.subject  ilike filter_subject)
      and (filter_syllabus is null or p.syllabus ilike filter_syllabus)
      and (filter_level    is null or p.level    ilike filter_level)
      and (filter_medium   is null or p.medium   ilike filter_medium)
  ),
  vector_matches as (
    select
      pc.id,
      row_number() over (order by pc.embedding <=> query_embedding) as rnk,
      1 - (pc.embedding <=> query_embedding) as similarity
    from paper_chunks pc
    join filtered_papers fp on fp.id = pc.paper_id
    where pc.embedding is not null
    order by pc.embedding <=> query_embedding
    limit match_count * 4
  ),
  text_matches as (
    select
      pc.id,
      row_number() over (
        order by ts_rank_cd(pc.content_tsv, websearch_to_tsquery('english', query_text)) desc
      ) as rnk,
      ts_rank_cd(pc.content_tsv, websearch_to_tsquery('english', query_text)) as rank
    from paper_chunks pc
    join filtered_papers fp on fp.id = pc.paper_id
    where query_text is not null
      and pc.content_tsv @@ websearch_to_tsquery('english', query_text)
    order by rank desc
    limit match_count * 4
  ),
  fused as (
    select
      coalesce(v.id, t.id) as id,
      coalesce(1.0 / (rrf_k + v.rnk), 0) + coalesce(1.0 / (rrf_k + t.rnk), 0) as fused_score,
      v.similarity,
      t.rank
    from vector_matches v
    full outer join text_matches t on t.id = v.id
  )
  select
    pc.id,
    pc.paper_id,
    pc.content,
    pc.chunk_index,
    f.similarity as vector_similarity,
    f.rank as text_rank,
    f.fused_score as score,
    row_to_json(p.*) as past_papers
  from fused f
  join paper_chunks pc on pc.id = f.id
  join papers p on p.id = pc.paper_id
  order by f.fused_score desc
  limit match_count;
end;
$function$;
