import { Link, useRouterState } from "@tanstack/react-router";
import {
	Bell,
	Bookmark,
	CalendarDays,
	Database,
	Gauge,
	Globe2,
	Heart,
	Home,
	Inbox,
	Link as LinkIcon,
	Mail,
	MessagesSquare,
	ShieldOff,
	UserSearch,
} from "lucide-react";
import {
	cx,
	navLinkActiveClass,
	navLinkClass,
	navLinkCompactClass,
	navLinkIconClass,
	navLinkLabelClass,
	navLinkLabelCompactClass,
	sidebarBrandClass,
	sidebarBrandCopyClass,
	sidebarBrandCopyCompactClass,
	sidebarBrandMarkClass,
	sidebarBrandTaglineClass,
	sidebarBrandTitleClass,
	sidebarShellCompactClass,
	sidebarFooterClass,
	sidebarNavClass,
	sidebarShellClass,
} from "#/lib/ui";
import { AccountSwitcher } from "./AccountSwitcher";
import { BirdclawMark } from "./BrandMark";
import { ThemeSlider } from "./ThemeSlider";
import { READ_ONLY_ARCHIVE_PAGES } from "#/lib/api-enums";
import { useDeploymentMode } from "#/lib/deployment-mode";

const links = [
	{ to: "/shared-inbox", label: "Shared mentions", icon: Inbox },
	{ to: "/inbox", label: "Inbox", icon: Inbox },
	{ to: "/today", label: "Today", icon: CalendarDays },
	{ to: "/discuss", label: "Discuss", icon: MessagesSquare },
	{ to: "/profile-analyze", label: "Analyse", icon: UserSearch },
	{ to: "/network-map", label: "Map", icon: Globe2 },
	{ to: "/data-sources", label: "Sources", icon: Database },
	{ to: "/", label: "Home", icon: Home },
	{ to: "/mentions", label: "Mentions", icon: Bell },
	{ to: "/likes", label: "Likes", icon: Heart },
	{ to: "/bookmarks", label: "Bookmarks", icon: Bookmark },
	{ to: "/links", label: "Links", icon: LinkIcon },
	{ to: "/rate-limits", label: "Rate Limits", icon: Gauge },
	{ to: "/dms", label: "DMs", icon: Mail },
	{ to: "/blocks", label: "Blocks", icon: ShieldOff },
] as const;

export function AppNav({ compact = false }: { compact?: boolean }) {
	const { readOnly, teamTriage } = useDeploymentMode();
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});

	return (
		<aside className={compact ? sidebarShellCompactClass : sidebarShellClass}>
			<div className="flex flex-col">
				<Link
					to={teamTriage ? "/shared-inbox" : "/"}
					className={sidebarBrandClass}
				>
					<span className={sidebarBrandMarkClass}>
						<BirdclawMark className="size-10" />
					</span>
					<span
						className={
							compact ? sidebarBrandCopyCompactClass : sidebarBrandCopyClass
						}
					>
						<span className={sidebarBrandTitleClass}>birdclaw</span>
						<span className={sidebarBrandTaglineClass}>
							{teamTriage
								? "Team mentions-only triage"
								: readOnly
									? "Read-only archive"
									: "Fast search for your archive."}
						</span>
					</span>
				</Link>
				<nav className={sidebarNavClass} aria-label="Primary">
					{links
						.filter((link) =>
							teamTriage
								? link.to === "/shared-inbox"
								: !readOnly || READ_ONLY_ARCHIVE_PAGES.includes(link.to),
						)
						.map((link) => {
							const active = pathname === link.to;
							const Icon = link.icon;
							return (
								<Link
									key={link.to}
									to={link.to}
									aria-label={link.label}
									className={cx(
										compact ? navLinkCompactClass : navLinkClass,
										active && navLinkActiveClass,
									)}
								>
									<Icon
										className={navLinkIconClass}
										size={22}
										strokeWidth={active ? 2.4 : 1.8}
										aria-hidden="true"
									/>
									<span
										className={
											compact ? navLinkLabelCompactClass : navLinkLabelClass
										}
									>
										{link.label}
									</span>
								</Link>
							);
						})}
				</nav>
			</div>
			<div className={sidebarFooterClass}>
				{teamTriage ? (
					<ThemeSlider compact />
				) : (
					<AccountSwitcher action={<ThemeSlider compact />} />
				)}
			</div>
		</aside>
	);
}
