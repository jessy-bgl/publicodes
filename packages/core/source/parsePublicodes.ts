import yaml from 'yaml'
import { ParsedRules, Logger, ASTNode } from '.'
import { makeASTTransformer, traverseParsedRules } from './AST'
import parse from './parse'
import { getReplacements, inlineReplacements } from './replacement'
import { Rule, RuleNode } from './rule'
import { disambiguateRuleReference } from './ruleUtils'
import { getUnitKey } from './units'

export type Context = {
	dottedName: string
	parsedRules: Record<string, RuleNode>
	ruleTitle?: string
	getUnitKey?: getUnitKey
	logger: Logger
}

type RawRule = Omit<Rule, 'nom'> | string | number
export type RawPublicodes = Record<string, RawRule>

export default function parsePublicodes(
	rawRules: RawPublicodes | string,
	partialContext: Partial<Context> = {}
): ParsedRules<string> {
	// STEP 1: parse Yaml
	let rules =
		typeof rawRules === 'string'
			? (yaml.parse(('' + rawRules).replace(/\t/g, '  ')) as RawPublicodes)
			: { ...rawRules }

	// STEP 2: transpile [ref] writing
	rules = transpileRef(rules)

	// STEP 3: Rules parsing
	const context: Context = {
		dottedName: partialContext.dottedName ?? '',
		parsedRules: partialContext.parsedRules ?? {},
		logger: partialContext.logger ?? console,
		getUnitKey: partialContext.getUnitKey ?? ((x) => x),
	}
	Object.entries(rules).forEach(([dottedName, rule]) => {
		if (typeof rule === 'string' || typeof rule === 'number') {
			rule = {
				formule: `${rule}`,
			}
		}
		if (typeof rule !== 'object') {
			throw new SyntaxError(
				`Rule ${dottedName} is incorrectly written. Please give it a proper value.`
			)
		}
		parse({ nom: dottedName, ...rule }, context)
	})
	let parsedRules = context.parsedRules

	// STEP 4: Disambiguate reference
	const dependencies = {}
	parsedRules = traverseParsedRules(
		disambiguateReference(parsedRules, dependencies),
		parsedRules
	)

	// topological sort rules
	// Throws an error if there is a cycle in the graph
	const topologicalOrder = topologicalSort(
		Object.keys(parsedRules),
		dependencies
	)

	// STEP 5: Inline replacements
	const replacements = getReplacements(parsedRules)
	parsedRules = traverseParsedRules(
		inlineReplacements(replacements, context.logger),
		parsedRules
	)

	// STEP 6: type inference
	const ruleUnits = inferRulesUnit(parsedRules, topologicalOrder)

	return parsedRules
}

// We recursively traverse the YAML tree in order to transform named parameters
// into rules.
function transpileRef(object: Record<string, any> | string | Array<any>) {
	if (Array.isArray(object)) {
		return object.map(transpileRef)
	}
	if (!object || typeof object !== 'object') {
		return object
	}
	object
	return Object.entries(object).reduce((obj, [key, value]) => {
		const match = /\[ref( (.+))?\]$/.exec(key)

		if (!match) {
			return { ...obj, [key]: transpileRef(value) }
		}

		const argumentType = key.replace(match[0], '').trim()
		const argumentName = match[2]?.trim() || argumentType

		return {
			...obj,
			[argumentType]: {
				nom: argumentName,
				valeur: transpileRef(value),
			},
		}
	}, {})
}

export const disambiguateReference = (
	parsedRules: Record<string, RuleNode>,
	dependencies: Record<string, Array<string>>
) =>
	makeASTTransformer((node) => {
		if (node.nodeKind === 'reference') {
			const dottedName = disambiguateRuleReference(
				parsedRules,
				node.contextDottedName,
				node.name
			)

			if (node.thisReferenceIsNotARealDependencyHack !== true) {
				dependencies[node.contextDottedName] = [
					...(dependencies[node.contextDottedName] ?? []),
					dottedName,
				]
			}

			return {
				...node,
				dottedName,
				title: parsedRules[dottedName].title,
				acronym: parsedRules[dottedName].rawNode.acronyme,
			}
		}
	})

// Standard topological sort algorithm
function topologicalSort<Names extends string>(
	rulesNames: Array<Names>,
	dependencyGraph: Record<Names, Array<Names>>
) {
	const result: Array<Names> = []
	const temp: Partial<Record<Names, Boolean>> = {}

	for (const ruleName of rulesNames) {
		if (!result.includes(ruleName)) {
			topologicalSortHelper(ruleName)
		}
	}

	function topologicalSortHelper(ruleName) {
		temp[ruleName] = true
		const nodeDependencies = dependencyGraph[ruleName] ?? []
		for (const dependency of nodeDependencies) {
			if (temp[dependency]) {
				// TODO: We could throw an error on a cycle but some tests are expecting
				// cycles to compile and to detect them at a letter stage with a
				// function taking the parsed rules as an input
				//
				// throw new Error( `Cycle detected in the graph. The node ${dependency}
				//  depends on ${ruleName}`
				// )
				continue
			}
			if (!result.includes(dependency)) {
				topologicalSortHelper(dependency)
			}
		}
		temp[ruleName] = false
		result.push(ruleName)
	}

	return result
}

// TODO: Currently only handle nullability, but the infering logic should be
// extended to support the full unit type system.
type InferedUnit = { isNullable: boolean }

function inferRulesUnit(parsedRules, topologicalOrder) {
	const res = {}
	topologicalOrder.forEach((ruleName) => {
		inferNodeUnit(parsedRules[ruleName])
	})

	function inferNodeUnit(node: ASTNode): InferedUnit {
		switch (node.nodeKind) {
			case 'somme':
			case 'produit':
			case 'barème':
			case 'durée':
			case 'grille':
			case 'taux progressif':
			case 'maximum':
			case 'minimum':
				return { isNullable: false }

			case 'applicable si':
			case 'non applicable si':
				return { isNullable: true }

			case 'constant':
				return { isNullable: node.nodeValue === null }

			case 'inversion':
			case 'operation':
			case 'par défaut':
			case 'recalcul':
			case 'replacementRule':
			case 'toutes ces conditions':
			case 'une de ces conditions':
			case 'une possibilité':
			case 'résoudre référence circulaire':
			case 'synchronisation':
				return { isNullable: false }

			case 'abattement':
				return inferNodeUnit(node.explanation.assiette)

			case 'arrondi':
			case 'nom dans la situation':
			case 'plafond':
			case 'plancher':
				return inferNodeUnit(node.explanation.valeur)

			case 'unité':
				return inferNodeUnit(node.explanation)

			case 'variations':
				return {
					isNullable: node.explanation.some(
						(line) => inferNodeUnit(line.consequence).isNullable
					),
				}

			case 'rule':
				const ruleName = node.dottedName
				res[ruleName] = inferNodeUnit(node.explanation.valeur)
				return res[ruleName]

			case 'reference':
				return res[node.dottedName as string]
		}
	}

	return res
}
