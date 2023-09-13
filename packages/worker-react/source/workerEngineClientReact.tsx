import React, {
	createContext,
	use,
	useContext,
	useMemo,
	useRef,
	useState,
} from 'react'

import { usePromise } from './hooks/usePromise'

import { ActionType, Config, WorkerEngineClient } from '@publicodes/worker'

export interface WorkerEngine<
	Cfg extends Config = Config,
	AdditionalActions extends ActionType = Cfg['additionalActions']
> extends WorkerEngineClient<AdditionalActions> {
	situationVersion: number
}

const WorkerEngineContext = createContext<WorkerEngine<Config>>(
	undefined as unknown as WorkerEngine<Config>
)

/**
 */
export const useWorkerEngine = <Cfg extends Config>() => {
	const context = useContext(WorkerEngineContext)

	if (!context) {
		throw new Error(
			'You are trying to use the worker engine outside of its provider'
		)
	}

	return context as WorkerEngine<Cfg>
}

/**
 */
const useSynchronizedWorkerEngine = <
	Cfg extends Config,
	AdditionalActions extends ActionType = Cfg['additionalActions']
>(
	workerClient: WorkerEngineClient<AdditionalActions>
): WorkerEngine<Cfg> => {
	const [situationVersion, setSituationVersion] = useState(0)
	const [workerEngine, setWorkerEngine] = useState<
		WorkerEngineClient<AdditionalActions>
	>(() => {
		workerClient.onSituationChange = function () {
			setSituationVersion((x) => x + 1)
		}

		return workerClient
	})

	const memo = useMemo(() => {
		return { ...workerEngine, situationVersion } as WorkerEngine<Cfg>
	}, [situationVersion, workerEngine])

	return memo
}

console.time('isWorkerReady')

/**
 */
export const WorkerEngineProvider = <
	Cfg extends Config,
	AdditionalActions extends ActionType = Cfg['additionalActions']
>({
	workerClient,
	children,
}: {
	workerClient: WorkerEngineClient<AdditionalActions>
	children: React.ReactNode
}) => {
	const workerEngine = useSynchronizedWorkerEngine(workerClient)

	// Wait for the worker to be ready before rendering the app
	use(workerEngine.isWorkerReady)

	return (
		<WorkerEngineContext.Provider value={workerEngine}>
			{children}
		</WorkerEngineContext.Provider>
	)
}

interface AsyncSetSituationOptions {
	options?: Parameters<WorkerEngine['asyncSetSituation']>[1]
	workerEngine?: WorkerEngine
}

/**
 */
export const useAsyncSetSituation = (
	situation: Parameters<WorkerEngine['asyncSetSituation']>[0],
	{ options, workerEngine: workerEngineOption }: AsyncSetSituationOptions
) => {
	const defaultWorkerEngine = useWorkerEngine()
	const workerEngine = workerEngineOption ?? defaultWorkerEngine

	return usePromise(
		() => workerEngine.asyncSetSituation(situation, options),
		[workerEngine, situation, options]
	)
}

/**
 * This hook is used to make a shallow copy of the worker engine.
 */
export const useAsyncShallowCopy = (
	workerEngine: WorkerEngine
): WorkerEngine | undefined => {
	const [situationVersion, setSituationVersion] = useState(0)

	const lastPromise = useRef<Promise<WorkerEngineClient> | null>(null)
	const workerEngineShallowCopy = usePromise(async () => {
		if (lastPromise.current) {
			lastPromise.current.then((last) =>
				setTimeout(() => {
					console.log('deleteShallowCopy', last.engineId)
					last.asyncDeleteShallowCopy()
				}, 10_000)
			)
		}

		lastPromise.current = workerEngine.asyncShallowCopy(() => {
			console.log('onSituationChange in shallow copy', copy.engineId)

			setSituationVersion((x) => x + 1)
		})

		const copy = await lastPromise.current

		return copy
	}, [workerEngine])

	const memo = useMemo(
		() =>
			workerEngineShallowCopy
				? { ...workerEngineShallowCopy, situationVersion }
				: undefined,
		[situationVersion, workerEngineShallowCopy]
	)

	return memo
}
