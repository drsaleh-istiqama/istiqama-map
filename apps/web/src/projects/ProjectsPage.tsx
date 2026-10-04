import { useMediaQuery } from '../ui';
import { ProjectList } from './ProjectList';

/** Project register (route `/projects`). Filters are remembered under the view key `projects`. */
export default function ProjectsPage() {
  const wide = useMediaQuery('(min-width: 900px)');
  return (
    <div class="ppage ppage--fill" data-testid="projects-page">
      <ProjectList viewKey="projects" filtersOpen={wide} />
    </div>
  );
}
