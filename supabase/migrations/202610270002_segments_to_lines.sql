begin;

alter table public.segments
	add column start_latitude double precision,
	add column start_longitude double precision,
	add column end_latitude double precision,
	add column end_longitude double precision;

with ordered_segments as (
	select
		id,
		lead(latitude) over (
			partition by story_id
			order by interval_start_seconds, id
		) as next_latitude,
		lead(longitude) over (
			partition by story_id
			order by interval_start_seconds, id
		) as next_longitude
	from public.segments
)
update public.segments as segment
set
	start_latitude = segment.latitude,
	start_longitude = segment.longitude,
	end_latitude = case
		when ordered_segments.next_latitude is not null
			and ordered_segments.next_longitude is not null
			then ordered_segments.next_latitude
		else segment.latitude
	end,
	end_longitude = case
		when ordered_segments.next_latitude is not null
			and ordered_segments.next_longitude is not null
			then ordered_segments.next_longitude
		else segment.longitude
	end
from ordered_segments
where ordered_segments.id = segment.id;

alter table public.segments
	add constraint segments_start_coordinates_pair
	check ((start_latitude is null) = (start_longitude is null)),
	add constraint segments_end_coordinates_pair
	check ((end_latitude is null) = (end_longitude is null)),
	add constraint segments_start_coordinates_range
	check (start_latitude between -90 and 90 and start_longitude between -180 and 180
		or start_latitude is null and start_longitude is null),
	add constraint segments_end_coordinates_range
	check (end_latitude between -90 and 90 and end_longitude between -180 and 180
		or end_latitude is null and end_longitude is null);

comment on column public.segments.start_latitude is
	'Latitude of the transcript interval start; pair with start_longitude as EPSG:4326 coordinates.';
comment on column public.segments.start_longitude is
	'Longitude of the transcript interval start; pair with start_latitude as EPSG:4326 coordinates.';
comment on column public.segments.end_latitude is
	'Latitude of the transcript interval end; pair with end_longitude as EPSG:4326 coordinates.';
comment on column public.segments.end_longitude is
	'Longitude of the transcript interval end; pair with end_latitude as EPSG:4326 coordinates.';

create index segments_story_interval_idx
	on public.segments (story_id, interval_start_seconds, id);

commit;
