import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { Container, type SelectItem, SelectList } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../../modes/theme/theme";
import { getThinkingLevelMetadata } from "../../thinking";
import { DynamicBorder } from "./dynamic-border";

/**
 * Component that renders a thinking level selector with borders
 */
export class ThinkingSelectorComponent extends Container {
	#selectList: SelectList;

	constructor(
		currentLevel: ThinkingLevel | undefined,
		availableLevels: ThinkingLevel[],
		onSelect: (level: ThinkingLevel) => void,
		onCancel: () => void,
	) {
		super();

		const thinkingLevels: SelectItem[] = availableLevels.map(getThinkingLevelMetadata);

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.#selectList = new SelectList(thinkingLevels, thinkingLevels.length, getSelectListTheme());

		// Preselect current level
		if (currentLevel !== undefined) {
			const currentIndex = thinkingLevels.findIndex(item => item.value === currentLevel);
			if (currentIndex !== -1) {
				this.#selectList.setSelectedIndex(currentIndex);
			}
		}

		this.#selectList.onSelect = item => {
			onSelect(item.value as ThinkingLevel);
		};

		this.#selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.#selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
}
