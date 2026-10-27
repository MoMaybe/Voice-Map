begin;

alter table public.stories
	add column user_id uuid not null references auth.users (id) on delete cascade;

alter table public.segments
	add column user_id uuid not null references auth.users (id) on delete cascade;

alter table public.segments
	alter column story_id set not null;

alter table public.segments
	add constraint segments_story_id_fkey
	foreign key (story_id) references public.stories (id) on delete cascade;

create index stories_user_created_idx
	on public.stories (user_id, created_at desc);

create index segments_user_story_idx
	on public.segments (user_id, story_id);

alter table public.stories enable row level security;
alter table public.segments enable row level security;

revoke all on table public.stories, public.segments from anon, authenticated;
grant select, insert, update, delete on table public.stories, public.segments to authenticated;
grant usage, select on sequence public.segments_id_seq to authenticated;

create policy stories_select_own
	on public.stories for select to authenticated
	using ((select auth.uid()) = user_id);

create policy stories_insert_own
	on public.stories for insert to authenticated
	with check ((select auth.uid()) = user_id);

create policy stories_update_own
	on public.stories for update to authenticated
	using ((select auth.uid()) = user_id)
	with check ((select auth.uid()) = user_id);

create policy stories_delete_own
	on public.stories for delete to authenticated
	using ((select auth.uid()) = user_id);

create policy segments_select_own
	on public.segments for select to authenticated
	using (
		(select auth.uid()) = user_id
		and exists (
			select 1
			from public.stories
			where stories.id = segments.story_id
				and stories.user_id = (select auth.uid())
		)
	);

create policy segments_insert_own
	on public.segments for insert to authenticated
	with check (
		(select auth.uid()) = user_id
		and exists (
			select 1
			from public.stories
			where stories.id = segments.story_id
				and stories.user_id = (select auth.uid())
		)
	);

create policy segments_update_own
	on public.segments for update to authenticated
	using ((select auth.uid()) = user_id)
	with check (
		(select auth.uid()) = user_id
		and exists (
			select 1
			from public.stories
			where stories.id = segments.story_id
				and stories.user_id = (select auth.uid())
		)
	);

create policy segments_delete_own
	on public.segments for delete to authenticated
	using ((select auth.uid()) = user_id);

commit;
