import { ContainerEvent } from './Container';
import { ContainerProxy } from './ContainerProxy';
import EventDispatcher from './EventDispatcher';
import * as Options from './Options';
import ScrollMagicEvent, { ScrollMagicEventType } from './ScrollMagicEvent';
import { getPixelDistance as getPixelValue } from './util/getRelativeDistance';
import pickDifferencesFlat from './util/pickDifferencesFlat';
import { pickRelevantProps, pickRelevantValues } from './util/pickRelevantInfo';
import throttleRaf from './util/throttleRaf';
import { numberToPercString } from './util/transformers';
import { isWindow } from './util/typeguards';
import validateObject from './util/validateObject';
import ViewportObserver, { defaultViewportObserverMargin } from './ViewportObserver';

export { Public as ScrollMagicOptions } from './Options';

// used for listeners to allow the value to be passed in either from the enum or as a string literal
type EventTypeEnumOrUnion = ScrollMagicEventType | `${ScrollMagicEventType}`;
export class Scene {
	public readonly name = 'ScrollMagic';

	private static defaultOptionsPublic = Options.defaults;

	private dispatcher = new EventDispatcher();
	private container = new ContainerProxy(this);
	private resizeObserver = new ResizeObserver(throttleRaf(this.onElementResize.bind(this)));
	private viewportObserver?: ViewportObserver;

	private optionsPublic: Options.Public = Scene.defaultOptionsPublic;
	private optionsPrivate!: Options.Private; // set in modify in constructor
	// TODO: only cache size
	private elementSize?: number; // cached element height
	private active?: boolean; // scene active state
	private currentProgress = 0;
	private isNaturalIntersection = true;

	// TODO: currently options.element isn't optional. Can we make it?
	constructor(options: Partial<Options.Public> = {}) {
		const initOptions: Options.Public = {
			...Scene.defaultOptionsPublic,
			...options,
		};
		this.modify(initOptions);
	}

	public modify(options: Partial<Options.Public>): Scene {
		const normalized = validateObject(options, Options.validationRules);

		this.optionsPublic = {
			...this.optionsPublic,
			...options,
		};

		const changed =
			undefined === this.optionsPrivate // internal options not set on first run, so all changed
				? normalized
				: pickDifferencesFlat(normalized, this.optionsPrivate);
		const changedOptions = Object.keys(changed) as Array<keyof Options.Private>;

		if (changedOptions.length === 0) {
			return this;
		}

		this.optionsPrivate = {
			...this.optionsPrivate,
			...normalized,
		};

		this.handleOptionChanges(changedOptions);
		return this;
	}

	private updateActiveState(nextActiveState: boolean) {
		if (nextActiveState === this.active) {
			return; // boring.
		}
		const isInitialLeave = undefined === this.active && !nextActiveState; // for the initial set to false there's no need to do anything
		this.active = nextActiveState;
		if (isInitialLeave) {
			return;
		}
		const type = this.active ? ScrollMagicEventType.Enter : ScrollMagicEventType.Leave;
		// TODO: this does not work reliably during scroll parent resize. make better.
		const forward = (this.progress !== 1 && this.active) || (this.progress !== 0 && !this.active);
		this.dispatcher.dispatchEvent(new ScrollMagicEvent(type, forward, this));
	}

	private getViewportMargin() {
		// todo: memoize all or part of this? Might not be worth it...
		const { vertical, trackEnd, trackStart, offset, height, element } = this.optionsPrivate;
		const { start, end } = pickRelevantProps(vertical);
		if (undefined === this.elementSize) {
			const { size: freshElementSize } = pickRelevantValues(vertical, element.getBoundingClientRect());
			this.elementSize = freshElementSize;
		}
		const elemSize = this.elementSize;
		const { size: containerSize } = pickRelevantValues(vertical, this.container.size);

		const trackStartMargin = trackStart - 1; // distance from bottom
		const trackEndMargin = -trackEnd; // distance from top

		// TODO: ask Pimm if this IIFE should get params or is ok to use parent values
		const [startOffset, endOffset] = (() => {
			if (this.isNaturalIntersection) {
				// if startOffset is 0 and height is 100% we can take a little shortcut here.
				return [0, 0];
			}
			const startOffset = getPixelValue(offset, elemSize) / containerSize;
			const relativeHeight = getPixelValue(height, elemSize) / containerSize;
			const endOffset = relativeHeight - elemSize / containerSize; // deduct elem height to correct for the fact that trackEnd cares for the end of the element
			return [startOffset, endOffset];
		})();

		// the start and end values are intentionally flipped here (start value defines end margin and vice versa)
		return {
			...defaultViewportObserverMargin,
			[end]: numberToPercString(trackStartMargin - startOffset),
			[start]: numberToPercString(trackEndMargin + startOffset + endOffset),
		};
	}

	private handleOptionChanges(changes: Array<keyof Options.Private>) {
		// TODO: consider what should happen to active state when parent or element are changed. Should leave / enter be dispatched?

		const isChanged = changes.includes.bind(changes);
		const heightChanged = isChanged('height');
		const offsetChanged = isChanged('offset');
		const elementChanged = isChanged('element');
		const scrollParentChanged = isChanged('scrollParent');

		// TODO: can this be written better?
		if (heightChanged || offsetChanged || elementChanged) {
			this.updateNaturalIntersection();
			if (heightChanged || elementChanged) {
				this.updateElementSize();
			}
			if (elementChanged) {
				this.resizeObserver.disconnect();
				this.resizeObserver.observe(this.optionsPrivate.element);
			}
		}
		if (scrollParentChanged) {
			this.container.attach(this.optionsPrivate.scrollParent, this.onContainerResize.bind(this));
		}
		// if the options change we always have to refresh the viewport observer, regardless which one it is...
		this.updateViewportObserver();
	}

	private updateNaturalIntersection() {
		// if there is no offset from the top and bottom of the element (default)
		// this allows for simpler calculations and less refreshes.
		const { offset, height } = this.optionsPrivate;
		const [offsetValue] = offset;
		const [heightValue, heightUnit] = height;
		this.isNaturalIntersection = offsetValue === 0 && heightValue === 1 && heightUnit === '%';
	}

	private updateElementSize() {
		if (this.isNaturalIntersection) {
			return;
		}
		const { vertical, element } = this.optionsPrivate;
		const { size: nextSize } = pickRelevantValues(vertical, element.getBoundingClientRect());
		this.elementSize = nextSize;
	}

	private updateProgress() {
		if (!this.active) {
			return;
		}
		const { vertical, trackEnd, trackStart, offset, element, height } = this.optionsPrivate;
		const { size: elemSize, start: elemStart } = pickRelevantValues(vertical, element.getBoundingClientRect()); //don't use cached value here, we need the current position
		const { size: containerSize } = pickRelevantValues(vertical, this.container.size);

		const startOffset = getPixelValue(offset, elemSize) / containerSize;
		const relativeHeight = getPixelValue(height, elemSize) / containerSize;
		const relativeStart = startOffset + elemStart / containerSize;
		const trackDistance = trackStart - trackEnd;

		const passed = trackStart - relativeStart;
		const total = relativeHeight + trackDistance;

		const progress = Math.min(Math.max(passed / total, 0), 1); // when leaving, it will overshoot, this normalises to 0 / 1
		if (progress !== this.currentProgress) {
			const forward = progress > this.progress;
			this.currentProgress = progress;
			this.dispatcher.dispatchEvent(new ScrollMagicEvent(ScrollMagicEventType.Progress, forward, this));
		}
	}

	private updateViewportObserver(): void {
		const { scrollParent, element } = this.optionsPrivate;
		const observerOptions = {
			margin: this.getViewportMargin(),
			root: isWindow(scrollParent) ? null : scrollParent,
		};

		if (undefined === this.viewportObserver) {
			this.viewportObserver = new ViewportObserver(this.onIntersect.bind(this), observerOptions).observe(element);
		} else {
			this.viewportObserver.updateOptions(observerOptions);
		}
	}

	private onElementResize() {
		const currentSize = this.elementSize;
		this.updateElementSize();
		const sizeChanged = currentSize !== this.elementSize;
		if (sizeChanged && !this.isNaturalIntersection) {
			this.updateViewportObserver();
		}
		this.updateProgress();
	}

	private onContainerResize(e: ContainerEvent) {
		if ('resize' === e.type) {
			this.updateViewportObserver();
		}
		this.updateProgress();
	}

	private onIntersect(intersecting: boolean, target: Element) {
		if (target === this.optionsPrivate.element) {
			// this should always be the case, as we only ever observe one element, but you can never be too sure, I guess...
			this.updateActiveState(intersecting);
			this.updateProgress();
		}
	}

	// getter/setter public
	public set element(element: Options.Public['element']) {
		this.modify({ element });
	}
	public get element(): Options.Public['element'] {
		return this.optionsPublic.element;
	}
	public set scrollParent(scrollParent: Options.Public['scrollParent']) {
		this.modify({ scrollParent });
	}
	public get scrollParent(): Options.Public['scrollParent'] {
		return this.optionsPublic.scrollParent;
	}
	public set vertical(vertical: Options.Public['vertical']) {
		this.modify({ vertical });
	}
	public get vertical(): Options.Public['vertical'] {
		return this.optionsPublic.vertical;
	}
	public set trackStart(trackStart: Options.Public['trackStart']) {
		this.modify({ trackStart });
	}
	public get trackStart(): Options.Public['trackStart'] {
		return this.optionsPublic.trackStart;
	}
	public set trackEnd(trackEnd: Options.Public['trackEnd']) {
		this.modify({ trackEnd });
	}
	public get trackEnd(): Options.Public['trackEnd'] {
		return this.optionsPublic.trackEnd;
	}
	public set offset(offset: Options.Public['offset']) {
		this.modify({ offset });
	}
	public get offset(): Options.Public['offset'] {
		return this.optionsPublic.offset;
	}
	public get progress(): number {
		return this.currentProgress;
	}
	public static default(options: Partial<Options.Public> = {}): Options.Public {
		validateObject(options, Options.validationRules);
		this.defaultOptionsPublic = {
			...this.defaultOptionsPublic,
			...options,
		};
		return this.defaultOptionsPublic;
	}

	// event listener
	public on(type: EventTypeEnumOrUnion, cb: (e: ScrollMagicEvent) => void): Scene {
		this.dispatcher.addEventListener(type as ScrollMagicEventType, cb);
		return this;
	}
	public off(type: EventTypeEnumOrUnion, cb: (e: ScrollMagicEvent) => void): Scene {
		this.dispatcher.removeEventListener(type as ScrollMagicEventType, cb);
		return this;
	}
	// same as on, but returns a function to reverse the effect (remove the listener).
	public subscribe(type: EventTypeEnumOrUnion, cb: (e: ScrollMagicEvent) => void): () => void {
		return this.dispatcher.addEventListener(type as ScrollMagicEventType, cb);
	}

	public destroy(): void {
		this.resizeObserver.disconnect();
		this.viewportObserver?.disconnect();
		this.container.detach();
	}
}
