/* eslint-disable prefer-const */
import { Bundle, Burn, Factory, Mint, Pool, Swap, Tick, Token,PoolFeeData } from '../types/schema'
import { Pool as PoolABI } from '../types/Factory/Pool'
import { BigDecimal, BigInt, ethereum, log} from '@graphprotocol/graph-ts'

import {
  Burn as BurnEvent,
  Collect,
  Initialize,
  Fee as ChangeFee,
  Mint as MintEvent,
  Swap as SwapEvent,
  CommunityFee
} from '../types/templates/Pool/Pool'
import { convertTokenToDecimal, loadTransaction, safeDiv } from '../utils'
import { FACTORY_ADDRESS, ONE_BI, ZERO_BD, ZERO_BI, pools_list, TICK_SPACING } from '../utils/constants'
import { findEthPerToken, getEthPriceInUSD, getTrackedAmountUSD, priceToTokenPrices } from '../utils/pricing'
import {
  updatePoolDayData,
  updatePoolHourData,
  updateTickDayData,
  updateTokenDayData,
  updateTokenHourData,
  updateAlgebraDayData,
  updateFeeHourData
} from '../utils/intervalUpdates'
import { createTick } from '../utils/tick'

export function handleInitialize(event: Initialize): void {
  let pool = Pool.load(event.address.toHexString())!

  pool.sqrtPrice = event.params.price
  pool.tick = BigInt.fromI32(event.params.tick)
  pool.save()
  // update token prices
  let token0 = Token.load(pool.token0)!
  let token1 = Token.load(pool.token1)!

  // update Matic price now that prices could have changed
  let bundle = Bundle.load('1')!
  bundle.maticPriceUSD = getEthPriceInUSD()
  bundle.save()
  updatePoolDayData(event)
  updatePoolHourData(event)
  // update token prices
  token0.derivedMatic = findEthPerToken(token0 as Token)
  token1.derivedMatic = findEthPerToken(token1 as Token)
  token0.save()
  token1.save()

}

export function handleMint(event: MintEvent): void {
  let bundle = Bundle.load('1')!
  let poolAddress = event.address.toHexString()
  let pool = Pool.load(poolAddress)!
  let factory = Factory.load(FACTORY_ADDRESS)!


  let token0 = Token.load(pool.token0)!
  let token1 = Token.load(pool.token1)!

  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  if(pools_list.includes(event.address.toHexString())){

    amount0 = convertTokenToDecimal(event.params.amount1, token0.decimals)
    amount1 = convertTokenToDecimal(event.params.amount0, token1.decimals)
  
  }

  let amountUSD = amount0
    .times(token0.derivedMatic.times(bundle.maticPriceUSD))
    .plus(amount1.times(token1.derivedMatic.times(bundle.maticPriceUSD)))

  // reset tvl aggregates until new amounts calculated
  factory.totalValueLockedMatic = factory.totalValueLockedMatic.minus(pool.totalValueLockedMatic)

  // update globals
  factory.txCount = factory.txCount.plus(ONE_BI)

  // update token0 data
  token0.txCount = token0.txCount.plus(ONE_BI)
  token0.totalValueLocked = token0.totalValueLocked.plus(amount0)
  token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedMatic.times(bundle.maticPriceUSD))

  // update token1 data
  token1.txCount = token1.txCount.plus(ONE_BI)
  token1.totalValueLocked = token1.totalValueLocked.plus(amount1)
  token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedMatic.times(bundle.maticPriceUSD))

  // pool data
  pool.txCount = pool.txCount.plus(ONE_BI)

  // Pools liquidity tracks the currently active liquidity given pools current tick.
  // We only want to update it on mint if the new position includes the current tick.
  if (
    pool.tick !== null &&
    BigInt.fromI32(event.params.bottomTick).le(pool.tick as BigInt) &&
    BigInt.fromI32(event.params.topTick).gt(pool.tick as BigInt)
  ) {
    pool.liquidity = pool.liquidity.plus(event.params.liquidityAmount)
  }
  pool.totalValueLockedToken0 = pool.totalValueLockedToken0.plus(amount0)
  pool.totalValueLockedToken1 = pool.totalValueLockedToken1.plus(amount1)
  pool.totalValueLockedMatic = pool.totalValueLockedToken0
    .times(token0.derivedMatic)
    .plus(pool.totalValueLockedToken1.times(token1.derivedMatic))
  pool.totalValueLockedUSD = pool.totalValueLockedMatic.times(bundle.maticPriceUSD)

  // reset aggregates with new amounts
  factory.totalValueLockedMatic = factory.totalValueLockedMatic.plus(pool.totalValueLockedMatic)
  factory.totalValueLockedUSD = factory.totalValueLockedMatic.times(bundle.maticPriceUSD)

  let transaction = loadTransaction(event)
  let mint = new Mint(transaction.id.toString() + '#' + pool.txCount.toString())
  mint.transaction = transaction.id
  mint.timestamp = transaction.timestamp
  mint.pool = pool.id
  mint.token0 = pool.token0
  mint.token1 = pool.token1
  mint.owner = event.params.owner
  mint.sender = event.params.sender
  mint.origin = event.transaction.from
  mint.amount = event.params.liquidityAmount
  mint.amount0 = amount0
  mint.amount1 = amount1
  mint.amountUSD = amountUSD
  mint.tickLower = BigInt.fromI32(event.params.bottomTick)
  mint.tickUpper = BigInt.fromI32(event.params.topTick)
  
  // tick entities
  let lowerTickIdx = event.params.bottomTick
  let upperTickIdx = event.params.topTick

  let lowerTickId = poolAddress + '#' + BigInt.fromI32(event.params.bottomTick).toString()
  let upperTickId = poolAddress + '#' + BigInt.fromI32(event.params.topTick).toString()

  let lowerTick = Tick.load(lowerTickId)
  let upperTick = Tick.load(upperTickId)

  if (lowerTick === null) {
    lowerTick = createTick(lowerTickId, lowerTickIdx, pool.id, event)
  }

  if (upperTick === null) {
    upperTick = createTick(upperTickId, upperTickIdx, pool.id, event)
  }

  let amount = event.params.liquidityAmount
  lowerTick.liquidityGross = lowerTick.liquidityGross.plus(amount)
  lowerTick.liquidityNet = lowerTick.liquidityNet.plus(amount)
  upperTick.liquidityGross = upperTick.liquidityGross.plus(amount)
  upperTick.liquidityNet = upperTick.liquidityNet.minus(amount)

  // TODO: Update Tick's volume, fees, and liquidity provider count

  updateAlgebraDayData(event)
  updatePoolDayData(event)
  updatePoolHourData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
  updateTokenHourData(token0 as Token, event)
  updateTokenHourData(token1 as Token, event)

  token0.save()
  token1.save()
  pool.save()
  factory.save()
  mint.save()

  // Update inner tick vars and save the ticks
  updateTickFeeVarsAndSave(lowerTick, event)
  updateTickFeeVarsAndSave(upperTick, event)

}

export function handleBurn(event: BurnEvent): void {
  
  let bundle = Bundle.load('1')!
  let poolAddress = event.address.toHexString()
  let pool = Pool.load(poolAddress)!
  let factory = Factory.load(FACTORY_ADDRESS)!

  let token0 = Token.load(pool.token0)!
  let token1 = Token.load(pool.token1)!

  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  if(pools_list.includes(event.address.toHexString())){

    amount0 = convertTokenToDecimal(event.params.amount1, token0.decimals)
    amount1 = convertTokenToDecimal(event.params.amount0, token1.decimals)
  
  }

  let amountUSD = amount0
    .times(token0.derivedMatic.times(bundle.maticPriceUSD))
    .plus(amount1.times(token1.derivedMatic.times(bundle.maticPriceUSD)))

  // reset tvl aggregates until new amounts calculated
  factory.totalValueLockedMatic = factory.totalValueLockedMatic.minus(pool.totalValueLockedMatic)

  // update globals
  factory.txCount = factory.txCount.plus(ONE_BI)

  // update token0 data
  token0.txCount = token0.txCount.plus(ONE_BI)
  token0.totalValueLocked = token0.totalValueLocked.minus(amount0)
  token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedMatic.times(bundle.maticPriceUSD))

  // update token1 data
  token1.txCount = token1.txCount.plus(ONE_BI)
  token1.totalValueLocked = token1.totalValueLocked.minus(amount1)
  token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedMatic.times(bundle.maticPriceUSD))

  // pool data
  pool.txCount = pool.txCount.plus(ONE_BI)
  // Pools liquidity tracks the currently active liquidity given pools current tick.
  // We only want to update it on burn if the position being burnt includes the current tick.
  if (
    pool.tick !== null &&
    BigInt.fromI32(event.params.bottomTick).le(pool.tick as BigInt) &&
    BigInt.fromI32(event.params.topTick).gt(pool.tick as BigInt)
  ) {
    pool.liquidity = pool.liquidity.minus(event.params.liquidityAmount)
  }

  pool.totalValueLockedToken0 = pool.totalValueLockedToken0.minus(amount0)
  pool.totalValueLockedToken1 = pool.totalValueLockedToken1.minus(amount1)
  pool.totalValueLockedMatic = pool.totalValueLockedToken0
    .times(token0.derivedMatic)
    .plus(pool.totalValueLockedToken1.times(token1.derivedMatic))
  pool.totalValueLockedUSD = pool.totalValueLockedMatic.times(bundle.maticPriceUSD)

  // reset aggregates with new amounts
  factory.totalValueLockedMatic = factory.totalValueLockedMatic.plus(pool.totalValueLockedMatic)
  factory.totalValueLockedUSD = factory.totalValueLockedMatic.times(bundle.maticPriceUSD)

  // burn entity
  let transaction = loadTransaction(event)
  let burn = new Burn(transaction.id + '#' + pool.txCount.toString())
  burn.transaction = transaction.id
  burn.timestamp = transaction.timestamp
  burn.pool = pool.id
  burn.token0 = pool.token0
  burn.token1 = pool.token1
  burn.owner = event.params.owner
  burn.origin = event.transaction.from
  burn.amount = event.params.liquidityAmount
  burn.amount0 = amount0
  burn.amount1 = amount1
  burn.amountUSD = amountUSD
  burn.tickLower = BigInt.fromI32(event.params.bottomTick)
  burn.tickUpper = BigInt.fromI32(event.params.topTick)


  // tick entities
  let lowerTickId = poolAddress + '#' + BigInt.fromI32(event.params.bottomTick).toString()
  let upperTickId = poolAddress + '#' + BigInt.fromI32(event.params.topTick).toString()
  let lowerTick = Tick.load(lowerTickId)!
  let upperTick = Tick.load(upperTickId)!
  let amount = event.params.liquidityAmount
  lowerTick.liquidityGross = lowerTick.liquidityGross.minus(amount)
  lowerTick.liquidityNet = lowerTick.liquidityNet.minus(amount)
  upperTick.liquidityGross = upperTick.liquidityGross.minus(amount)
  upperTick.liquidityNet = upperTick.liquidityNet.plus(amount)

  updateAlgebraDayData(event)
  updatePoolDayData(event)
  updatePoolHourData(event)
  updateTokenDayData(token0 as Token, event)
  updateTokenDayData(token1 as Token, event)
  updateTokenHourData(token0 as Token, event)
  updateTokenHourData(token1 as Token, event)
  updateTickFeeVarsAndSave(lowerTick, event)
  updateTickFeeVarsAndSave(upperTick, event)

  token0.save()
  token1.save()
  pool.save()
  factory.save()
  burn.save()
}

export function handleSwap(event: SwapEvent): void {
  let bundle = Bundle.load('1')!
  let factory = Factory.load(FACTORY_ADDRESS)!
  let pool = Pool.load(event.address.toHexString())!

  let oldTick = pool.tick
  let flag = false 


  let token0 = Token.load(pool.token0)!
  let token1 = Token.load(pool.token1)!


  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)

  if(pools_list.includes(event.address.toHexString())){

    amount0 = convertTokenToDecimal(event.params.amount1, token0.decimals)
    amount1 = convertTokenToDecimal(event.params.amount0, token1.decimals)

  
  }

 // need absolute amounts for volume
 let amount0Abs = amount0
 if (amount0.lt(ZERO_BD)) {
   amount0Abs = amount0.times(BigDecimal.fromString('-1'))
 }
 else { 
   let communityFeeAmount = amount0.times(BigDecimal.fromString((pool.fee.times(pool.communityFee0).toString())).div(BigDecimal.fromString('1000000000')))
   communityFeeAmount = communityFeeAmount.times(BigDecimal.fromString("1")) 
   amount0 = amount0.minus(communityFeeAmount)
   amount0Abs = amount0
 } 

 let amount1Abs = amount1
 if (amount1.lt(ZERO_BD)) {
   amount1Abs = amount1.times(BigDecimal.fromString('-1'))
 }
 else{
   let communityFeeAmount = amount1.times(BigDecimal.fromString((pool.fee.times(pool.communityFee1).toString())).div(BigDecimal.fromString('1000000000')))
   communityFeeAmount = communityFeeAmount.times(BigDecimal.fromString("1"))  
   amount1 = amount1.minus(communityFeeAmount)
   amount1Abs = amount1
 }

  let amount0Matic = amount0Abs.times(token0.derivedMatic)
  let amount1Matic = amount1Abs.times(token1.derivedMatic)

  let amount0USD = amount0Matic.times(bundle.maticPriceUSD)
  let amount1USD = amount1Matic.times(bundle.maticPriceUSD)



  // get amount that should be tracked only - div 2 because cant count both input and output as volume
  let amountTotalUSDTracked = getTrackedAmountUSD(amount0Abs, token0 as Token, amount1Abs, token1 as Token).div(
    BigDecimal.fromString('2')
  )

  let amountTotalMaticTracked = safeDiv(amountTotalUSDTracked, bundle.maticPriceUSD)
  let amountTotalUSDUntracked = amount0USD.plus(amount1USD).div(BigDecimal.fromString('2'))

  let feesMatic = amountTotalMaticTracked.times(pool.fee.toBigDecimal()).div(BigDecimal.fromString('1000000'))
  let feesUSD = amountTotalUSDTracked.times(pool.fee.toBigDecimal()).div(BigDecimal.fromString('1000000'))
  let untrackedFees = amountTotalUSDUntracked.times(pool.fee.toBigDecimal()).div(BigDecimal.fromString('1000000'))


  // global updates
  factory.txCount = factory.txCount.plus(ONE_BI)
  factory.totalVolumeMatic = factory.totalVolumeMatic.plus(amountTotalMaticTracked)
  factory.totalVolumeUSD = factory.totalVolumeUSD.plus(amountTotalUSDTracked)
  factory.untrackedVolumeUSD = factory.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  factory.totalFeesMatic = factory.totalFeesMatic.plus(feesMatic)
  factory.totalFeesUSD = factory.totalFeesUSD.plus(feesUSD)

  // reset aggregate tvl before individual pool tvl updates
  let currentPoolTvlMatic = pool.totalValueLockedMatic
  factory.totalValueLockedMatic = factory.totalValueLockedMatic.minus(currentPoolTvlMatic)


  // pool volume
  pool.volumeToken0 = pool.volumeToken0.plus(amount0Abs)
  pool.volumeToken1 = pool.volumeToken1.plus(amount1Abs)
  pool.volumeUSD = pool.volumeUSD.plus(amountTotalUSDTracked)
  pool.untrackedVolumeUSD = pool.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  pool.feesUSD = pool.feesUSD.plus(feesUSD)
  pool.untrackedFeesUSD = pool.untrackedFeesUSD.plus(untrackedFees)
  pool.txCount = pool.txCount.plus(ONE_BI)

  // Update the pool with the new active liquidity, price, and tick.
  pool.liquidity = event.params.liquidity
  pool.tick = BigInt.fromI32(event.params.tick as i32)
  pool.sqrtPrice = event.params.price
  pool.totalValueLockedToken0 = pool.totalValueLockedToken0.plus(amount0)
  pool.totalValueLockedToken1 = pool.totalValueLockedToken1.plus(amount1)

  // update token0 data
  token0.volume = token0.volume.plus(amount0Abs)
  token0.totalValueLocked = token0.totalValueLocked.plus(amount0)
  token0.volumeUSD = token0.volumeUSD.plus(amountTotalUSDTracked)
  token0.untrackedVolumeUSD = token0.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  token0.feesUSD = token0.feesUSD.plus(feesUSD)
  token0.txCount = token0.txCount.plus(ONE_BI)

  // update token1 data
  token1.volume = token1.volume.plus(amount1Abs)
  token1.totalValueLocked = token1.totalValueLocked.plus(amount1)
  token1.volumeUSD = token1.volumeUSD.plus(amountTotalUSDTracked)
  token1.untrackedVolumeUSD = token1.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  token1.feesUSD = token1.feesUSD.plus(feesUSD)
  token1.txCount = token1.txCount.plus(ONE_BI)

  // updated pool ratess
 

  let prices = priceToTokenPrices(pool.sqrtPrice, token0 as Token, token1 as Token)
  pool.token0Price = prices[0]
  pool.token1Price = prices[1]

  if(pools_list.includes(event.address.toHexString())){
    prices = priceToTokenPrices(pool.sqrtPrice, token1 as Token, token0 as Token)
    pool.token0Price = prices[1]
    pool.token1Price = prices[0]
  }


  pool.save()

  // update USD pricing
  bundle.maticPriceUSD = getEthPriceInUSD()
  bundle.save()

  token0.derivedMatic = findEthPerToken(token0 as Token)
  token1.derivedMatic = findEthPerToken(token1 as Token)

  /**
   * Things afffected by new USD rates
   */
  pool.totalValueLockedMatic = pool.totalValueLockedToken0
    .times(token0.derivedMatic)
    .plus(pool.totalValueLockedToken1.times(token1.derivedMatic))
  pool.totalValueLockedUSD = pool.totalValueLockedMatic.times(bundle.maticPriceUSD)

  factory.totalValueLockedMatic = factory.totalValueLockedMatic.plus(pool.totalValueLockedMatic)
  factory.totalValueLockedUSD = factory.totalValueLockedMatic.times(bundle.maticPriceUSD)

  token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedMatic).times(bundle.maticPriceUSD)
  token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedMatic).times(bundle.maticPriceUSD)

  // create Swap event
  let transaction = loadTransaction(event)
  let swap = new Swap(transaction.id + '#' + pool.txCount.toString())
  swap.transaction = transaction.id
  swap.timestamp = transaction.timestamp
  swap.pool = pool.id
  swap.token0 = pool.token0
  swap.token1 = pool.token1
  swap.sender = event.params.sender
  swap.origin = event.transaction.from
  swap.liquidity = event.params.liquidity
  swap.recipient = event.params.recipient
  swap.amount0 = amount0
  swap.amount1 = amount1
  swap.amountUSD = amountTotalUSDTracked
  swap.tick = BigInt.fromI32(event.params.tick as i32)
  swap.price = event.params.price


  // update fee growth
  let poolContract = PoolABI.bind(event.address)
  let feeGrowthGlobal0X128 = poolContract.totalFeeGrowth0Token()
  let feeGrowthGlobal1X128 = poolContract.totalFeeGrowth1Token()
  pool.feeGrowthGlobal0X128 = feeGrowthGlobal0X128 as BigInt
  pool.feeGrowthGlobal1X128 = feeGrowthGlobal1X128 as BigInt

  // interval data
  let algebraDayData = updateAlgebraDayData(event)
  let poolDayData = updatePoolDayData(event)
  let poolHourData = updatePoolHourData(event)
  let token0DayData = updateTokenDayData(token0 as Token, event)
  let token1DayData = updateTokenDayData(token1 as Token, event)
  let token0HourData = updateTokenHourData(token0 as Token, event)
  let token1HourData = updateTokenHourData(token1 as Token, event)

  if(amount0.lt(ZERO_BD)){
    pool.feesToken1 = pool.feesToken1.plus(amount1.times(pool.fee.toBigDecimal()).div(BigDecimal.fromString('1000000')))
    poolDayData.feesToken1 = poolDayData.feesToken1.plus(amount1.times(pool.fee.toBigDecimal()).div(BigDecimal.fromString('1000000')))
  }

  if(amount1.lt(ZERO_BD) ){
    pool.feesToken0 = pool.feesToken0.plus(amount0.times(pool.fee.toBigDecimal()).div(BigDecimal.fromString('1000000')))
    poolDayData.feesToken0 = poolDayData.feesToken0.plus(amount0.times(pool.fee.toBigDecimal()).div(BigDecimal.fromString('1000000')))
  }

  // update volume metrics
  algebraDayData.volumeMatic = algebraDayData.volumeMatic.plus(amountTotalMaticTracked)
  algebraDayData.volumeUSD = algebraDayData.volumeUSD.plus(amountTotalUSDTracked)
  algebraDayData.feesUSD = algebraDayData.feesUSD.plus(feesUSD)

  poolDayData.volumeUSD = poolDayData.volumeUSD.plus(amountTotalUSDTracked)
  poolDayData.untrackedVolumeUSD = poolDayData.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  poolDayData.volumeToken0 = poolDayData.volumeToken0.plus(amount0Abs)
  poolDayData.volumeToken1 = poolDayData.volumeToken1.plus(amount1Abs)
  poolDayData.feesUSD = poolDayData.feesUSD.plus(feesUSD)

  
  poolHourData.untrackedVolumeUSD = poolHourData.untrackedVolumeUSD.plus(amountTotalUSDUntracked)
  poolHourData.volumeUSD = poolHourData.volumeUSD.plus(amountTotalUSDTracked)
  poolHourData.volumeToken0 = poolHourData.volumeToken0.plus(amount0Abs)
  poolHourData.volumeToken1 = poolHourData.volumeToken1.plus(amount1Abs)
  poolHourData.feesUSD = poolHourData.feesUSD.plus(feesUSD)

  token0DayData.volume = token0DayData.volume.plus(amount0Abs)
  token0DayData.volumeUSD = token0DayData.volumeUSD.plus(amountTotalUSDTracked)
  token0DayData.untrackedVolumeUSD = token0DayData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token0DayData.feesUSD = token0DayData.feesUSD.plus(feesUSD)

  token0HourData.volume = token0HourData.volume.plus(amount0Abs)
  token0HourData.volumeUSD = token0HourData.volumeUSD.plus(amountTotalUSDTracked)
  token0HourData.untrackedVolumeUSD = token0HourData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token0HourData.feesUSD = token0HourData.feesUSD.plus(feesUSD)

  token1DayData.volume = token1DayData.volume.plus(amount1Abs)
  token1DayData.volumeUSD = token1DayData.volumeUSD.plus(amountTotalUSDTracked)
  token1DayData.untrackedVolumeUSD = token1DayData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token1DayData.feesUSD = token1DayData.feesUSD.plus(feesUSD)

  token1HourData.volume = token1HourData.volume.plus(amount1Abs)
  token1HourData.volumeUSD = token1HourData.volumeUSD.plus(amountTotalUSDTracked)
  token1HourData.untrackedVolumeUSD = token1HourData.untrackedVolumeUSD.plus(amountTotalUSDTracked)
  token1HourData.feesUSD = token1HourData.feesUSD.plus(feesUSD)

  swap.save()
  token0DayData.save()
  token1DayData.save()
  algebraDayData.save()
  poolHourData.save()
  poolDayData.save()
  factory.save()
  pool.save()
  token0.save()
  token1.save()
  
  // Update inner vars of current or crossed ticks
  let newTick = pool.tick
  let modulo = newTick.mod(TICK_SPACING)
  if (modulo.equals(ZERO_BI)) {
    // Current tick is initialized and needs to be updated
    loadTickUpdateFeeVarsAndSave(newTick.toI32(), event)
  }

  let numIters = oldTick
    .minus(newTick)
    .abs()
    .div(TICK_SPACING)

  if (numIters.gt(BigInt.fromI32(100))) {
    // In case more than 100 ticks need to be updated ignore the update in
    // order to avoid timeouts. From testing this behavior occurs only upon
    // pool initialization. This should not be a big issue as the ticks get
    // updated later. For early users this error also disappears when calling
    // collect
  } else if (newTick.gt(oldTick)) {
    let firstInitialized = oldTick.plus(TICK_SPACING.minus(modulo))
    for (let i = firstInitialized; i.le(newTick); i = i.plus(TICK_SPACING)) {
      loadTickUpdateFeeVarsAndSave(i.toI32(), event)
    }
  } else if (newTick.lt(oldTick)) {
    let firstInitialized = oldTick.minus(modulo)
    for (let i = firstInitialized; i.ge(newTick); i = i.minus(TICK_SPACING)) {
      loadTickUpdateFeeVarsAndSave(i.toI32(), event)
    }
  }
}

export function handleSetCommunityFee(event: CommunityFee): void {
  let pool = Pool.load(event.address.toHexString())
  if (pool){
    pool.communityFee0 = BigInt.fromI32(event.params.communityFee0New)
    pool.communityFee1 = BigInt.fromI32(event.params.communityFee1New)
    pool.save() 
  }

}

export function handleCollect(event: Collect): void {
  let transaction = loadTransaction(event)
  let bundle = Bundle.load('1')!
  let poolAddress = event.address.toHexString()
  let pool = Pool.load(poolAddress)!
  let factory = Factory.load(FACTORY_ADDRESS)!
 
 
  let token0 = Token.load(pool.token0)!
  let token1 = Token.load(pool.token1)! 
 
  let amount0 = convertTokenToDecimal(event.params.amount0, token0.decimals)
  let amount1 = convertTokenToDecimal(event.params.amount1, token1.decimals)
 
  if(transaction){
 
      let burn = Burn.load(transaction.id + '#' + pool.txCount.minus(ONE_BI).toString())
      if(burn){
        amount0 = amount0.minus(burn.amount0)
        amount1 = amount1.minus(burn.amount1) 
      }
      let burn2 = Burn.load(transaction.id + '#' + pool.txCount.toString())
      if(burn2){

        amount0 = amount0.minus(burn2.amount0)
        amount1 = amount1.minus(burn2.amount1) 

      }
  }
 
  let amountUSD = amount0
    .times(token0.derivedMatic.times(bundle.maticPriceUSD))
    .plus(amount1.times(token1.derivedMatic.times(bundle.maticPriceUSD)))
 
  // reset tvl aggregates until new amounts calculated
  factory.totalValueLockedMatic = factory.totalValueLockedMatic.minus(pool.totalValueLockedMatic)
 
  // update globals
  factory.txCount = factory.txCount.plus(ONE_BI)
 
  // update token0 data
  token0.txCount = token0.txCount.plus(ONE_BI)
  token0.totalValueLocked = token0.totalValueLocked.minus(amount0)
  token0.totalValueLockedUSD = token0.totalValueLocked.times(token0.derivedMatic.times(bundle.maticPriceUSD))
 
  // update token1 data
  token1.txCount = token1.txCount.plus(ONE_BI)
  token1.totalValueLocked = token1.totalValueLocked.minus(amount1)
  token1.totalValueLockedUSD = token1.totalValueLocked.times(token1.derivedMatic.times(bundle.maticPriceUSD))
 
  // pool data
  pool.txCount = pool.txCount.plus(ONE_BI)
 
  pool.totalValueLockedToken0 = pool.totalValueLockedToken0.minus(amount0)
  pool.totalValueLockedToken1 = pool.totalValueLockedToken1.minus(amount1)
  pool.totalValueLockedMatic = pool.totalValueLockedToken0
    .times(token0.derivedMatic)
    .plus(pool.totalValueLockedToken1.times(token1.derivedMatic))
  pool.totalValueLockedUSD = pool.totalValueLockedMatic.times(bundle.maticPriceUSD)
 
  // reset aggregates with new amounts
  factory.totalValueLockedMatic = factory.totalValueLockedMatic.plus(pool.totalValueLockedMatic)
  factory.totalValueLockedUSD = factory.totalValueLockedMatic.times(bundle.maticPriceUSD)
 
  token0.save()
  token1.save()
  pool.save()
  factory.save()
 
}


function updateTickFeeVarsAndSave(tick: Tick, event: ethereum.Event): void {
  let poolAddress = event.address
  // not all ticks are initialized so obtaining null is expected behavior
  let poolContract = PoolABI.bind(poolAddress)

  let tickResult = poolContract.ticks(tick.tickIdx.toI32())
  tick.feeGrowthOutside0X128 = tickResult.value2
  tick.feeGrowthOutside1X128 = tickResult.value3
  tick.save()
  updateTickDayData(tick, event)
}

export function handleChangeFee(event: ChangeFee): void {

  let pool = Pool.load(event.address.toHexString())!
  pool.fee = BigInt.fromI32(event.params.fee as i32)
  pool.save()

  let fee = PoolFeeData.load(event.block.timestamp.toString() + event.address.toHexString())
  if (fee == null){
    fee = new PoolFeeData(event.block.timestamp.toString() + event.address.toHexString())
    fee.pool = event.address.toHexString()
    fee.fee = BigInt.fromI32(event.params.fee)
    fee.timestamp = event.block.timestamp
  }
  else{
    fee.fee = BigInt.fromI32(event.params.fee)  
  }
  updateFeeHourData(event, BigInt.fromI32(event.params.fee))
  fee.save()
}


function loadTickUpdateFeeVarsAndSave(tickId: i32, event: ethereum.Event): void {
  let poolAddress = event.address
  let tick = Tick.load(   
    poolAddress
      .toHexString()
      .concat('#')
      .concat(tickId.toString())
  )
  if (tick !== null) {
    updateTickFeeVarsAndSave(tick, event)
  }
}
