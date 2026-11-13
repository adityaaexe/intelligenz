/**
 * `@intelligenz/design-system`
 *
 * Tokens (contract §10): `src/tokens.css` is a byte-identical port of
 * `prototype/assets/css/tokens.css`; `src/theme.css` is the Tailwind v4 bridge;
 * `src/primitives.css` is the component layer. One palette, three files, no
 * duplicated values.
 *
 * Components are deliberately dependency-free React. Most are pure and work in
 * a Server Component; `DataTable` is the only one that carries `'use client'`.
 */

export const PACKAGE_NAME = '@intelligenz/design-system' as const;

// components
export { Banner } from './components/banner';
export type { BannerProps, BannerVariant } from './components/banner';
export { Button, ButtonLink } from './components/button';
export type { ButtonProps, ButtonSize, ButtonVariant } from './components/button';
export { Chip } from './components/chip';
export type { ChipProps } from './components/chip';
export { DataTable } from './components/data-table';
export type { ColumnHideBelow, DataTableColumn, DataTableProps } from './components/data-table';
export { EmptyState } from './components/empty-state';
export type { EmptyStateProps } from './components/empty-state';
export { Field, Input } from './components/field';
export type { FieldProps, FieldRenderArgs, InputProps } from './components/field';
export { Icon } from './components/icon';
export type { IconName, IconProps } from './components/icon';
export { MetricTile } from './components/metric-tile';
export type { MetricTileProps } from './components/metric-tile';
export { NotInstrumented } from './components/not-instrumented';
export type { NotInstrumentedProps } from './components/not-instrumented';
export { Panel } from './components/panel';
export type { PanelProps } from './components/panel';
export { RiskBadge, riskFromWire } from './components/risk-badge';
export type { RiskBadgeProps, RiskLevel } from './components/risk-badge';
export { Skeleton, SkeletonStack, SkeletonTable } from './components/skeleton';
export type { SkeletonProps, SkeletonStackProps, SkeletonTableProps } from './components/skeleton';
export { StatusPill } from './components/status-pill';
export type { StatusPillProps } from './components/status-pill';
export { Timestamp } from './components/timestamp';
export type { TimestampProps } from './components/timestamp';

// pure logic — shared by the app and by the unit tests
export {
  durationBetween,
  formatAbsoluteUtc,
  formatCost,
  formatCount,
  formatDuration,
  formatRelative,
  formatTokenCount,
  timestampParts,
} from './lib/format';
export { ariaSort, compareValues, nextSortState, sortBy } from './lib/sort';
export type { AriaSort, SortDirection, SortState, SortValue } from './lib/sort';
export { describeStatus, glyphForTone, STATUS_TONES } from './lib/status';
export type { GlyphName, StatusDescriptor, StatusTone } from './lib/status';
export { isSimulatedRuntime, runtimeLabel } from './lib/runtime';
